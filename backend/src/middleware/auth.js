const db = require('../db');
const { E } = require('../errors');
const { verifyAccess } = require('../services/tokens');

// Loads req.user from the Bearer token. Checks token_version, blocked, deleted.
async function loadUserFromToken(token) {
  const claims = verifyAccess(token);
  const user = await db.one(
    `SELECT id, full_name, phone, phone_verified_at, email, google_sub, password_hash IS NOT NULL AS has_password,
            role, is_blocked, token_version, deleted_at, created_at
       FROM users WHERE id = $1`,
    [claims.sub],
  );
  if (!user || user.deleted_at) throw E.unauth('INVALID_TOKEN', 'Account not found');
  if (user.is_blocked) throw E.forbidden('USER_BLOCKED', 'This account is blocked. Contact support.');
  if (user.token_version !== claims.tv) throw E.unauth('TOKEN_REVOKED', 'Logged out, log in again');
  user.sessionId = claims.sid;
  user.tokenExp = claims.exp;
  return user;
}

async function requireUser(req, _res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw E.unauth();
    req.user = await loadUserFromToken(m[1]);
    req.isAdmin = req.user.role === 'super_admin';
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, _res, next) {
  if (!req.isAdmin) return next(E.forbidden('ADMIN_ONLY', 'Admin only'));
  next();
}

module.exports = { requireUser, requireAdmin, loadUserFromToken };
