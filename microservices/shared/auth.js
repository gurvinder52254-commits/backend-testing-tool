/**
 * ============================================================
 * microservices/shared/auth.js — Token verification
 * ============================================================
 * Verifies the SAME tokens the monolith issues:
 *   - `webtest_session_...`  → local HMAC session token
 *   - `ey...`                → Google ID token (JWT)
 *   - otherwise              → Google OAuth access token
 * Returns a normalized user, or throws on invalid/expired.
 *
 * Kept as a plain function (not Express middleware) so both the
 * REST gateway and the WebSocket gateway can reuse it. The
 * signature check uses crypto.timingSafeEqual (an improvement
 * over the monolith's `!==`).
 * ============================================================
 */

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('./config');

const googleClient = new OAuth2Client(config.auth.googleClientId);

function verifySessionToken(token) {
  const parts = token.substring('webtest_session_'.length).split('.');
  if (parts.length !== 2) throw new Error('Invalid token structure');

  const [payloadB64, signature] = parts;
  const expected = crypto
    .createHmac('sha256', config.auth.sessionSecret)
    .update(payloadB64)
    .digest('base64');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid token signature');
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
  if (Date.now() > payload.expiry) {
    const e = new Error('Session token expired');
    e.isExpired = true;
    throw e;
  }
  return {
    userId: payload.userId,
    email: payload.email,
    name: payload.name,
    picture: payload.picture || null,
  };
}

async function verifyGoogleIdToken(token) {
  const ticket = await googleClient.verifyIdToken({
    idToken: token,
    audience: config.auth.googleClientId,
  });
  const p = ticket.getPayload();
  return { userId: p.sub, email: p.email, name: p.name, picture: p.picture || null };
}

async function verifyGoogleAccessToken(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Access token verification failed');
  const p = await res.json();
  return { userId: p.sub, email: p.email, name: p.name, picture: p.picture || null };
}

/**
 * Verify any supported token; returns a normalized user object.
 * Also best-effort upserts the user profile (same as the monolith).
 */
async function verifyToken(token) {
  if (!token) throw new Error('Missing token');

  let user;
  if (token.startsWith('webtest_session_')) {
    user = verifySessionToken(token);
  } else if (token.startsWith('ey')) {
    user = await verifyGoogleIdToken(token);
  } else {
    user = await verifyGoogleAccessToken(token);
  }

  // Best-effort profile upsert — never blocks auth on a DB hiccup.
  try {
    const User = require('../../models/User');
    await User.upsertUser({
      id: user.userId,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });
  } catch (_) {
    /* non-fatal */
  }

  return user;
}

/**
 * Express middleware wrapper around verifyToken().
 */
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  try {
    const user = await verifyToken(header.split(' ')[1]);
    req.userId = user.userId;
    req.userEmail = user.email;
    req.userName = user.name;
    req.userPicture = user.picture;
    next();
  } catch (err) {
    const expired = err.isExpired || /expire/i.test(err.message);
    return res.status(401).json({
      success: false,
      error: expired ? 'Token expired. Please login again.' : 'Invalid token.',
    });
  }
}

module.exports = { verifyToken, requireAuth, verifySessionToken };
