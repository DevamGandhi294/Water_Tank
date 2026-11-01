// 2. My account
const express = require('express');
const db = require('../db');
const { E } = require('../errors');
const { z, parse, password } = require('../lib/validate');
const { normalizePhone, iso } = require('../lib/format');
const { hashPassword, checkPassword } = require('../lib/crypto');
const ser = require('../lib/serialize');
const tokens = require('../services/tokens');
const realtime = require('../services/realtime');
const events = require('../services/events');
const { createOtp, checkOtp, requireSms } = require('./auth');
const { limiter } = require('../middleware/rateLimit');

const router = express.Router();

const fullUser = (id) => db.one('SELECT * FROM users WHERE id = $1', [id]);

// 2.1
router.get('/', async (req, res) => {
  const u = await fullUser(req.user.id);
  const n = await db.one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ...ser.user(u), unreadNotifications: n.n });
});

// 2.2
router.patch('/', async (req, res) => {
  const b = parse(z.object({
    fullName: z.string().trim().min(1).max(100).optional(),
    email: z.union([z.string().trim().toLowerCase().email().max(200), z.null()]).optional(),
  }), req.body);
  if (b.email) {
    const taken = await db.one('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [b.email, req.user.id]);
    if (taken) throw E.conflict('EMAIL_TAKEN', 'This email is used by another account', 'email');
  }
  const u = await db.one(
    `UPDATE users SET full_name = COALESCE($2, full_name),
            email = CASE WHEN $3::boolean THEN $4 ELSE email END
      WHERE id = $1 RETURNING *`,
    [req.user.id, b.fullName ?? null, b.email !== undefined, b.email ?? null],
  );
  res.json(ser.user(u));
});

// 2.3
router.post('/password', limiter('mepw', { limit: 5, keyFn: (r) => r.user.id, failuresOnly: true }), async (req, res) => {
  const b = parse(z.object({ currentPassword: z.string().max(128).optional(), newPassword: password }), req.body);
  const u = await fullUser(req.user.id);
  if (u.password_hash) {
    if (!b.currentPassword || !(await checkPassword(b.currentPassword, u.password_hash))) {
      throw E.invalid('BAD_PASSWORD', 'Current password is wrong', 'currentPassword');
    }
  }
  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(b.newPassword)]);
  // other phones stay logged in; "log out of all phones" is a separate button
  res.status(204).end();
});

// 2.4 / 2.5 add or change phone (needs SMS)
router.post('/phone', async (req, res) => {
  requireSms();
  const b = parse(z.object({ phone: z.string() }), req.body);
  const phone = normalizePhone(b.phone);
  const taken = await db.one('SELECT 1 FROM users WHERE phone = $1 AND id <> $2 AND deleted_at IS NULL', [phone, req.user.id]);
  if (taken) throw E.conflict('PHONE_TAKEN', 'This phone number already has an account', 'phone');
  res.json(await createOtp(phone, 'verify_phone', req.user.id));
});
router.post('/phone/verify', async (req, res) => {
  requireSms();
  const b = parse(z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/) }), req.body);
  const phone = normalizePhone(b.phone);
  await checkOtp(phone, 'verify_phone', b.code, req.user.id);
  const u = await db.one('UPDATE users SET phone = $2, phone_verified_at = now() WHERE id = $1 RETURNING *', [req.user.id, phone]);
  res.json(ser.user(u));
});

// 2.6 / 2.7 push tokens
router.post('/push-tokens', async (req, res) => {
  const b = parse(z.object({ fcmToken: z.string().min(10).max(4096), platform: z.enum(['android', 'ios', 'web']) }), req.body);
  await db.query(
    `INSERT INTO push_tokens (user_id, fcm_token, platform) VALUES ($1,$2,$3)
     ON CONFLICT (fcm_token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen_at = now()`,
    [req.user.id, b.fcmToken, b.platform],
  );
  res.status(204).end();
});
router.delete('/push-tokens/:fcmToken', async (req, res) => {
  await db.query('DELETE FROM push_tokens WHERE fcm_token = $1 AND user_id = $2', [req.params.fcmToken, req.user.id]);
  res.status(204).end();
});

// 2.8 / 2.9 sessions
router.get('/sessions', async (req, res) => {
  const rows = await db.many(
    `SELECT id, device_label, ip, created_at FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [req.user.id],
  );
  res.json({
    items: rows.map((r) => ({
      id: r.id, deviceLabel: r.device_label, ip: r.ip, createdAt: iso(r.created_at), current: r.id === req.user.sessionId,
    })),
  });
});
router.delete('/sessions/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw E.notFound();
  await db.query('DELETE FROM refresh_tokens WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.status(204).end();
});

// 2.10 delete account (soft). Owned tanks are released; shares removed.
router.delete('/', async (req, res) => {
  const b = parse(z.object({ password: z.string().max(128).optional() }), req.body);
  const u = await fullUser(req.user.id);
  if (u.password_hash && !(b.password && (await checkPassword(b.password, u.password_hash)))) {
    throw E.invalid('BAD_PASSWORD', 'Password is wrong', 'password');
  }
  const released = await db.tx(async (c) => {
    const owned = await c.many('SELECT id FROM devices WHERE owner_id = $1', [u.id]);
    const members = await c.many('SELECT device_id, user_id FROM device_shares WHERE device_id = ANY($1::uuid[])', [owned.map((d) => d.id)]);
    await c.query('DELETE FROM device_shares WHERE device_id = ANY($1::uuid[]) OR user_id = $2', [owned.map((d) => d.id), u.id]);
    await c.query('DELETE FROM device_invites WHERE device_id = ANY($1::uuid[]) AND accepted_at IS NULL', [owned.map((d) => d.id)]);
    await c.query('UPDATE devices SET owner_id = NULL, claimed_at = NULL, claim_code_hash = NULL WHERE owner_id = $1', [u.id]);
    for (const d of owned) await events.add(d.id, 'unclaimed', { message: 'Owner deleted their account', data: { reason: 'account_deleted' } }, c);
    await c.query('DELETE FROM push_tokens WHERE user_id = $1', [u.id]);
    await c.query('DELETE FROM alert_settings WHERE user_id = $1', [u.id]);
    await tokens.revokeAll(u.id, c);
    await c.query(
      `UPDATE users SET deleted_at = now(), full_name = 'Deleted user', phone = NULL, email = NULL,
              google_sub = NULL, password_hash = NULL WHERE id = $1`,
      [u.id],
    );
    return members;
  });
  released.forEach((m) => realtime.removeFromDevice(m.user_id, m.device_id));
  realtime.disconnectUser(u.id);
  res.status(204).end();
});

module.exports = router;
