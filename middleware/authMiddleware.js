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
        if (token.startsWith('ey')) {
            // JWT ID Token verification
            const ticket = await client.verifyIdToken({
                idToken: token,
                audience: CLIENT_ID,
            });
            const payload = ticket.getPayload();
            req.userId = payload.sub;
            req.userEmail = payload.email;
            req.userName = payload.name;
        } else {
            // Access Token verification via Google UserInfo API
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
        }
        next();
    } catch (err) {
        console.error('Auth verification error:', err.message);
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired Google token. Please login again.',
        });
    }
}

module.exports = { verifyGoogleToken };
