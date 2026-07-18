/**
 * ============================================================
 * authMiddleware.js - Google OAuth Token Verification
 * ============================================================
 * Verifies Google ID token from Authorization header.
 * Extracts userId (Google 'sub') and attaches to req.userId.
 * ============================================================
 */

const { OAuth2Client } = require('google-auth-library');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '272763569916-bhpu0j2v70tvkpj9dmppjehtpdn4f3ec.apps.googleusercontent.com';

const client = new OAuth2Client(CLIENT_ID);

const crypto = require('crypto');
const SESSION_SECRET = process.env.SESSION_SECRET || 'webtest_secret_default_key_123456';

/**
 * Generates a signed session token valid for 7 days
 */
function generateSessionToken(user) {
    const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    const payloadObj = {
        userId: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        expiry: expiry
    };
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
    const hmac = crypto.createHmac('sha256', SESSION_SECRET);
    hmac.update(payload);
    const signature = hmac.digest('base64');
    return `webtest_session_${payload}.${signature}`;
}

/**
 * Verifies a session token and returns decoded payload
 */
function verifySessionToken(token) {
    if (!token.startsWith('webtest_session_')) {
        throw new Error('Invalid session token format');
    }
    const tokenParts = token.substring('webtest_session_'.length).split('.');
    if (tokenParts.length !== 2) {
        throw new Error('Invalid token structure');
    }
    const [payload, signature] = tokenParts;
    const hmac = crypto.createHmac('sha256', SESSION_SECRET);
    hmac.update(payload);
    const expectedSignature = hmac.digest('base64');

    if (signature !== expectedSignature) {
        throw new Error('Invalid token signature');
    }

    const payloadObj = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    if (Date.now() > payloadObj.expiry) {
        const expiredError = new Error('Google token expired');
        expiredError.isExpired = true;
        throw expiredError;
    }

    return payloadObj;
}

async function verifyGoogleToken(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required. Please login with Google.',
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        if (token.startsWith('webtest_session_')) {
            // Local Session Token verification (7-day validity)
            const payload = verifySessionToken(token);
            req.userId = payload.userId;
            req.userEmail = payload.email;
            req.userName = payload.name;
            req.userPicture = payload.picture || null;
        } else if (token.startsWith('ey')) {
            // JWT ID Token verification (initial Google Login)
            const ticket = await client.verifyIdToken({
                idToken: token,
                audience: CLIENT_ID,
            });
            const payload = ticket.getPayload();
            req.userId = payload.sub;
            req.userEmail = payload.email;
            req.userName = payload.name;
            req.userPicture = payload.picture || null;
        } else {
            // Access Token verification via Google UserInfo API (initial Google Login)
            const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!response.ok) {
                throw new Error('Access token verification failed');
            }
            const payload = await response.json();
            req.userId = payload.sub;
            req.userEmail = payload.email;
            req.userName = payload.name;
            req.userPicture = payload.picture || null;
        }

        // Upsert user profile to PostgreSQL database asynchronously
        try {
            const User = require('../models/User');
            await User.upsertUser({
                id: req.userId,
                email: req.userEmail,
                name: req.userName,
                picture: req.userPicture
            });
        } catch (dbErr) {
            console.error('⚠️ Failed to save user to PostgreSQL:', dbErr.message);
        }

        next();
    } catch (err) {
        console.error('Auth verification error:', err.message);
        const isExpired = err.isExpired || err.message.includes('expired') || err.message.includes('exp');
        return res.status(401).json({
            success: false,
            error: isExpired ? 'Google token expired' : 'Invalid or expired Google token. Please login again.',
        });
    }
}

/**
 * Middleware to verify if user has at least 1 credit remaining.
 */
async function checkCredits(req, res, next) {
    const userId = req.userId;
    if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Authentication required.' });
    }

    try {
        const { pool } = require('../config/db');
        const userRes = await pool.query('SELECT credits, subscription_tier FROM users WHERE id = $1', [userId]);

        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User profile not found.' });
        }

        const { credits, subscription_tier } = userRes.rows[0];
        
        // Free plan URL count safety check
        if (subscription_tier === 'Free') {
            const totalUrlsRes = await pool.query(
                "SELECT COALESCE(SUM(total_pages), 0)::int as count FROM reports WHERE user_id = $1 AND status != 'failed'",
                [userId]
            );
            const totalUrlsTested = totalUrlsRes.rows[0].count || 0;
            if (totalUrlsTested >= 5) {
                await pool.query("UPDATE users SET credits = 0 WHERE id = $1", [userId]);
                return res.status(402).json({
                    success: false,
                    error: 'Payment Required: Insufficient scan credits. Please purchase credits or upgrade your plan.',
                    code: 'CREDITS_EXHAUSTED'
                });
            }
        }

        // 1. Core Credits Check
        if (credits <= 0) {
            return res.status(402).json({
                success: false,
                error: 'Payment Required: Insufficient scan credits. Please purchase credits or upgrade your plan.',
                code: 'CREDITS_EXHAUSTED'
            });
        }

        // 2. Plan Limits Enforcements (only for PAID plans — Free plan is governed by the 5-URL ceiling above)
        if (subscription_tier && subscription_tier !== 'Free') {
            const PLAN_LIMITS = {
                'Basic':    { domains: 20,  scans: 200   },
                'Pro':      { domains: 50,  scans: 1500  },
                'Business': { domains: 100, scans: 10000 },
            };

            const limits = PLAN_LIMITS[subscription_tier] || PLAN_LIMITS['Basic'];

            // Monthly scan count check
            const monthScansRes = await pool.query(
                `SELECT COUNT(*)::int as count FROM reports WHERE user_id = $1 AND test_date >= date_trunc('month', CURRENT_DATE)`,
                [userId]
            );
            const currentMonthScans = monthScansRes.rows[0].count || 0;

            if (currentMonthScans >= limits.scans) {
                return res.status(403).json({
                    success: false,
                    error: `Plan Limit Exceeded: You have used ${currentMonthScans}/${limits.scans} monthly scans for your ${subscription_tier} plan. Please upgrade to run more scans.`,
                    code: 'SCAN_LIMIT_EXHAUSTED'
                });
            }

            // Domain Limits check
            const domainsRes = await pool.query(
                `SELECT COUNT(DISTINCT (
                  CASE 
                    WHEN frontend_url LIKE 'http%' THEN 
                      replace(split_part(frontend_url, '/', 3), 'www.', '')
                    ELSE 
                      replace(frontend_url, 'www.', '')
                  END
                ))::int as count FROM reports WHERE user_id = $1`,
                [userId]
            );
            const uniqueDomainsCount = domainsRes.rows[0].count || 0;

            const targetUrl = req.body.frontendUrl;
            if (targetUrl) {
                let targetDomain = '';
                try {
                    const cleanUrl = targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl;
                    const u = new URL(cleanUrl);
                    targetDomain = u.hostname.replace('www.', '');
                } catch (e) {}

                if (targetDomain) {
                    const domainCheckRes = await pool.query(
                        `SELECT 1 FROM reports WHERE user_id = $1 AND frontend_url LIKE $2 LIMIT 1`,
                        [userId, `%${targetDomain}%`]
                    );
                    const isExistingDomain = domainCheckRes.rows.length > 0;

                    if (!isExistingDomain && uniqueDomainsCount >= limits.domains) {
                        return res.status(403).json({
                            success: false,
                            error: `Plan Limit Exceeded: You have reached the unique domain limit of ${uniqueDomainsCount}/${limits.domains} on your ${subscription_tier} plan. Please upgrade to scan new domains.`,
                            code: 'DOMAIN_LIMIT_EXHAUSTED'
                        });
                    }
                }
            }
        }

        next();

    } catch (err) {
        console.error('Error verifying user credits and limits:', err.message);
        res.status(500).json({ success: false, error: 'Server error: ' + err.message });
    }
}

module.exports = { verifyGoogleToken, generateSessionToken, checkCredits };

