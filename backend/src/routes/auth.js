// 1. Auth
const express = require('express');
const db = require('../db');
const config = require('../config');
const { E } = require('../errors');
const { z, parse, password } = require('../lib/validate');
const { normalizePhone } = require('../lib/format');
const { hashPassword, checkPassword, otpCode, otpHash, sha256 } = require('../lib/crypto');
const sms = require('../lib/sms');
const tokens = require('../services/tokens');
const ser = require('../lib/serialize');
const { requireUser } = require('../middleware/auth');
const { limiter } = require('../middleware/rateLimit');

const router = express.Router();

const phoneKey = (req) => String((req.body && req.body.phone) || '').replace(/\D/g, '');
const deviceLabel = z.string().max(100).optional();

async function loginResponse(user, req, extra = {}) {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const s = await tokens.issueSession(user, { deviceLabel: req.body && req.body.deviceLabel, ip: req.ip });
  const fresh = await db.one('SELECT * FROM users WHERE id = $1', [user.id]);
  return { accessToken: s.accessToken, refreshToken: s.refreshToken, user: ser.user(fresh), ...extra };
}

function assertCanLogin(u) {
  if (u.is_blocked) throw E.forbidden('USER_BLOCKED', 'This account is blocked. Contact support.');
}

async function createOtp(phone, purpose, userId) {
  // max 5 codes per phone per 10 minutes, and one every 30 s
  const recent = await db.one(
    `SELECT count(*)::int AS n, max(created_at) AS last FROM otp_codes
      WHERE phone = $1 AND created_at > now() - interval '10 minutes'`,
    [phone],
  );
  if (recent.n >= 5) throw E.tooMany('Too many codes requested. Try again in 10 minutes.');
  if (recent.last && Date.now() - new Date(recent.last).getTime() < 30_000) {
    throw E.tooMany('Wait 30 seconds before asking for a new code.');
  }
  const code = otpCode();
  await db.query(
    `INSERT INTO otp_codes (phone, user_id, purpose, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '10 minutes')`,
    [phone, userId || null, purpose, otpHash(phone, purpose, code)],
  );
  await sms.sendOtp(phone, code);
  return { sent: true, resendAfterS: 30 };
}

// returns true when the code is right; counts wrong tries (max 5 per code)
async function checkOtp(phone, purpose, code, userId) {
  const row = await db.one(
    `SELECT * FROM otp_codes WHERE phone = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        AND ($3::uuid IS NULL OR user_id = $3) ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose, userId || null],
  );
  if (!row || row.attempts >= 5) throw E.invalid('OTP_EXPIRED', 'Code expired, ask for a new one', 'code');
  if (row.code_hash !== otpHash(phone, purpose, String(code))) {
    await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw E.invalid('OTP_INVALID', 'Wrong code', 'code');
  }
  await db.query('UPDATE otp_codes SET used_at = now() WHERE id = $1', [row.id]);
  return true;
}

function requireSms() {
  if (!sms.enabled()) throw E.notEnabled('SMS codes are not enabled on this server');
}

// 1.1 register
router.post('/register', limiter('register', { limit: 10, keyFn: phoneKey }), async (req, res) => {
  const b = parse(z.object({ fullName: z.string().trim().min(1).max(100), phone: z.string(), password, deviceLabel }), req.body);
  const phone = normalizePhone(b.phone);
  const existing = await db.one('SELECT * FROM users WHERE phone = $1 AND deleted_at IS NULL', [phone]);
  const hash = await hashPassword(b.password);

  if (!sms.enabled()) {
    // no SMS provider: phone + password only, the account is usable at once
    if (existing) throw E.conflict('PHONE_TAKEN', 'This phone number already has an account', 'phone');
    const u = await db.one(
      `INSERT INTO users (full_name, phone, password_hash, phone_verified_at) VALUES ($1,$2,$3, now()) RETURNING *`,
      [b.fullName, phone, hash],
    );
    return res.status(201).json({ userId: u.id, otpSent: false, ...(await loginResponse(u, req)) });
  }

  let u;
  if (existing && existing.phone_verified_at) throw E.conflict('PHONE_TAKEN', 'This phone number already has an account', 'phone');
  if (existing) {
    // signed up before but never verified: take the new name / password and send a new code
    u = await db.one('UPDATE users SET full_name = $2, password_hash = $3 WHERE id = $1 RETURNING *', [existing.id, b.fullName, hash]);
  } else {
    u = await db.one('INSERT INTO users (full_name, phone, password_hash) VALUES ($1,$2,$3) RETURNING *', [b.fullName, phone, hash]);
  }
  await createOtp(phone, 'verify_phone', u.id);
  res.status(201).json({ userId: u.id, otpSent: true });
});

// 1.2 send OTP
router.post('/otp/send', limiter('otp', { limit: 5, keyFn: phoneKey }), async (req, res) => {
  requireSms();
  const b = parse(z.object({ phone: z.string(), purpose: z.enum(['verify_phone', 'login', 'reset_password']) }), req.body);
  const phone = normalizePhone(b.phone);
  const u = await db.one('SELECT * FROM users WHERE phone = $1 AND deleted_at IS NULL', [phone]);
  // do not reveal whether the phone has an account
  if (!u) return res.json({ sent: true, resendAfterS: 30 });
  if (b.purpose === 'verify_phone' && u.phone_verified_at) return res.json({ sent: true, resendAfterS: 30 });
  res.json(await createOtp(phone, b.purpose, u.id));
});

// 1.3 verify OTP
router.post('/otp/verify', limiter('otpv', { limit: 10, keyFn: phoneKey }), async (req, res) => {
  requireSms();
  const b = parse(z.object({
    phone: z.string(), purpose: z.enum(['verify_phone', 'login', 'reset_password']),
    code: z.string().regex(/^\d{6}$/, 'must be 6 digits'), deviceLabel,
  }), req.body);
  const phone = normalizePhone(b.phone);
  const u = await db.one('SELECT * FROM users WHERE phone = $1 AND deleted_at IS NULL', [phone]);
  if (!u) throw E.invalid('OTP_INVALID', 'Wrong code', 'code');
  await checkOtp(phone, b.purpose, b.code);
  assertCanLogin(u);
  if (b.purpose === 'reset_password') {
    const resetToken = tokens.signPurpose('reset', { sub: u.id, tv: u.token_version }, 600);
    return res.json({ resetToken });
  }
  if (!u.phone_verified_at) await db.query('UPDATE users SET phone_verified_at = now() WHERE id = $1', [u.id]);
  res.json(await loginResponse(u, req));
});

// 1.4 login
router.post('/login', limiter('login', { limit: 5, keyFn: phoneKey, failuresOnly: true }), async (req, res) => {
  const b = parse(z.object({ phone: z.string(), password: z.string().min(1).max(128), deviceLabel }), req.body);
  const phone = normalizePhone(b.phone);
  const u = await db.one('SELECT * FROM users WHERE phone = $1 AND deleted_at IS NULL', [phone]);
  const ok = u && (await checkPassword(b.password, u.password_hash));
  if (!ok) throw E.unauth('BAD_CREDENTIALS', 'Wrong phone number or password');
  assertCanLogin(u);
  if (!u.phone_verified_at) {
    if (sms.enabled()) throw E.forbidden('PHONE_NOT_VERIFIED', 'Verify your phone number first');
    await db.query('UPDATE users SET phone_verified_at = now() WHERE id = $1', [u.id]);
  }
  res.json(await loginResponse(u, req));
});

// 1.5 Google sign-in: turned off for now (decision 2026-11-01)
router.post('/google', (_req, _res) => {
  throw E.notEnabled('Google sign-in is not enabled on this server');
});

// 1.6 refresh
router.post('/refresh', limiter('refresh', { limit: 60 }), async (req, res) => {
  const b = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
  res.json(await tokens.rotateRefresh(b.refreshToken, req.ip));
});

// 1.7 logout (this phone)
router.post('/logout', requireUser, async (req, res) => {
  const b = parse(z.object({ refreshToken: z.string().optional() }), req.body);
  if (b.refreshToken) {
    // deleted, not revoked: a revoked token used again means theft (see rotateRefresh)
    await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2', [sha256(b.refreshToken), req.user.id]);
  } else if (req.user.sessionId) {
    await db.query('DELETE FROM refresh_tokens WHERE id = $1', [req.user.sessionId]);
  }
  res.status(204).end();
});

// 1.8 logout everywhere
router.post('/logout-all', requireUser, async (req, res) => {
  await tokens.revokeAll(req.user.id);
  require('../services/realtime').disconnectUser(req.user.id);
  res.status(204).end();
});

// 1.9 reset password with the token from 1.3
router.post('/password/reset', limiter('reset', { limit: 10 }), async (req, res) => {
  const b = parse(z.object({ resetToken: z.string(), newPassword: password }), req.body);
  const claims = tokens.verifyPurpose('reset', b.resetToken);
  if (!claims) throw E.invalid('RESET_TOKEN_INVALID', 'Reset link expired, start again');
  const u = await db.one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [claims.sub]);
  if (!u || u.token_version !== claims.tv) throw E.invalid('RESET_TOKEN_INVALID', 'Reset link expired, start again');
  await db.tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(b.newPassword)]);
    await tokens.revokeAll(u.id, c);
  });
  res.status(204).end();
});

module.exports = { router, createOtp, checkOtp, requireSms, config };
