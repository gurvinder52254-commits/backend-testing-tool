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

module.exports = { verifyGoogleToken, generateSessionToken };

