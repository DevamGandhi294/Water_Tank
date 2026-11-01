// Access token = JWT (15 min) with sub, role, tv (token_version), sid (refresh token row id).
// Refresh token = random string, stored as sha256, rotated on every refresh.
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { sha256, randomToken } = require('../lib/crypto');
const { E } = require('../errors');

function signAccess(user, sid) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.token_version, sid }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.accessTtlS,
    audience: 'access',
  });
}

function verifyAccess(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: 'access' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw E.unauth('TOKEN_EXPIRED', 'Access token expired');
    throw E.unauth('INVALID_TOKEN', 'Invalid access token');
  }
}

// purpose-bound short tokens (password reset, firmware download)
function signPurpose(purpose, payload, ttlS) {
  return jwt.sign(payload, config.jwtSecret, { algorithm: 'HS256', expiresIn: ttlS, audience: purpose });
}
function verifyPurpose(purpose, token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: purpose });
  } catch {
    return null;
  }
}

async function issueSession(user, { deviceLabel, ip } = {}, client = db) {
  const refreshToken = randomToken(32);
  const row = await client.one(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_label, ip, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id`,
    [user.id, sha256(refreshToken), deviceLabel || null, ip || null, config.refreshTtlDays],
  );
  return { accessToken: signAccess(user, row.id), refreshToken, sessionId: row.id };
}

async function rotateRefresh(refreshToken, ip) {
  if (typeof refreshToken !== 'string' || !refreshToken) throw E.unauth('INVALID_REFRESH', 'Invalid refresh token');
  const out = await db.tx(async (c) => {
    const rt = await c.one(
      `SELECT r.*, u.role, u.token_version, u.is_blocked, u.deleted_at
         FROM refresh_tokens r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1 FOR UPDATE OF r`,
      [sha256(refreshToken)],
    );
    if (!rt || rt.deleted_at) throw E.unauth('INVALID_REFRESH', 'Invalid refresh token');
    // a rotated token was used again: treat as stolen, log out everywhere (after this tx)
    if (rt.revoked_at) return { reused: rt.user_id };
    if (new Date(rt.expires_at) < new Date()) throw E.unauth('REFRESH_EXPIRED', 'Session expired, log in again');
    if (rt.is_blocked) throw E.forbidden('USER_BLOCKED', 'This account is blocked. Contact support.');
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [rt.id]);
    const user = { id: rt.user_id, role: rt.role, token_version: rt.token_version };
    const s = await issueSession(user, { deviceLabel: rt.device_label, ip }, c);
    return { accessToken: s.accessToken, refreshToken: s.refreshToken };
  });
  if (out.reused) {
    await revokeAll(out.reused);
    throw E.unauth('INVALID_REFRESH', 'Refresh token was already used');
  }
  return out;
}

async function revokeAll(userId, client = db) {
  await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
}

module.exports = { signAccess, verifyAccess, signPurpose, verifyPurpose, issueSession, rotateRefresh, revokeAll };
