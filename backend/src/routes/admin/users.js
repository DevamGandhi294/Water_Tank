// 10.16 - 10.21 admin: users (+ password reset by admin, because there is no SMS)
const express = require('express');
const db = require('../../db');
const { E } = require('../../errors');
const { z, parse, password } = require('../../lib/validate');
const { iso, pageLimit, decodeCursor, encodeCursor } = require('../../lib/format');
const { hashPassword } = require('../../lib/crypto');
const { audit } = require('../../lib/audit');
const ser = require('../../lib/serialize');
const tokens = require('../../services/tokens');
const realtime = require('../../services/realtime');
const views = require('../../services/deviceViews');
const alerts = require('../../services/alerts');

const router = express.Router();

router.get('/', async (req, res) => {
  const limit = pageLimit(req.query.limit, 50, 200);
  const offset = (decodeCursor(req.query.cursor) || {}).o || 0;
  const q = req.query.q ? String(req.query.q).trim() : null;
  const role = ['super_admin', 'user'].includes(req.query.role) ? req.query.role : null;
  const blocked = req.query.blocked === 'true' ? true : req.query.blocked === 'false' ? false : null;
  const where = `u.deleted_at IS NULL
      AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%'
           OR (length(regexp_replace($1, '[^0-9]', '', 'g')) >= 3 AND u.phone LIKE '%' || regexp_replace($1, '[^0-9]', '', 'g') || '%'))
      AND ($2::user_role IS NULL OR u.role = $2)
      AND ($3::boolean IS NULL OR u.is_blocked = $3)`;
  const params = [q, role, blocked];
  const [rows, total] = await Promise.all([
    db.many(
      `SELECT u.*, (SELECT count(*) FROM devices d WHERE d.owner_id = u.id)::int AS owned,
              (SELECT count(*) FROM device_shares s WHERE s.user_id = u.id)::int AS shared
         FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT $4 OFFSET $5`,
      [...params, limit + 1, offset],
    ),
    db.one(`SELECT count(*)::int AS n FROM users u WHERE ${where}`, params),
  ]);
  const more = rows.length > limit;
  res.json({
    items: rows.slice(0, limit).map((u) => ({
      id: u.id, fullName: u.full_name, phone: u.phone, email: u.email, role: u.role, isBlocked: u.is_blocked,
      devicesOwned: u.owned, devicesShared: u.shared, lastLoginAt: iso(u.last_login_at), createdAt: iso(u.created_at),
    })),
    total: total.n,
    nextCursor: more ? encodeCursor({ o: offset + limit }) : null,
  });
});

async function loadUser(req) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw E.notFound('USER_NOT_FOUND', 'User not found');
  const u = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!u) throw E.notFound('USER_NOT_FOUND', 'User not found');
  return u;
}

async function detail(u) {
  const owned = await db.many('SELECT id FROM devices WHERE owner_id = $1 ORDER BY claimed_at', [u.id]);
  const shared = await db.many('SELECT device_id, permission FROM device_shares WHERE user_id = $1', [u.id]);
  const sessions = await db.many(
    `SELECT id, device_label, ip, created_at FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`, [u.id]);
  const notes = await db.many(
    `SELECT n.*, COALESCE(d.name, d.serial_no) AS device_name FROM notifications n LEFT JOIN devices d ON d.id = n.device_id
      WHERE n.user_id = $1 ORDER BY n.id DESC LIMIT 20`, [u.id]);
  return {
    ...ser.user(u),
    isBlocked: u.is_blocked,
    blockedReason: u.blocked_reason,
    blockedAt: iso(u.blocked_at),
    lastLoginAt: iso(u.last_login_at),
    deletedAt: iso(u.deleted_at),
    ownedDevices: await Promise.all(owned.map((d) => views.cardFor(d.id, 'owner'))),
    sharedDevices: await Promise.all(shared.map((s) => views.cardFor(s.device_id, s.permission))),
    sessions: sessions.map((s) => ({ id: s.id, deviceLabel: s.device_label, ip: s.ip, createdAt: iso(s.created_at) })),
    notifications: notes.map(alerts.serialize),
  };
}

router.get('/:id', async (req, res) => {
  res.json(await detail(await loadUser(req)));
});

router.post('/:id/block', async (req, res) => {
  const u = await loadUser(req);
  const b = parse(z.object({ reason: z.string().trim().min(1).max(200) }), req.body);
  if (u.id === req.user.id) throw E.conflict('CANNOT_BLOCK_SELF', 'You cannot block your own account');
  await db.tx(async (c) => {
    await c.query('UPDATE users SET is_blocked = true, blocked_reason = $2, blocked_at = now() WHERE id = $1', [u.id, b.reason]);
    await tokens.revokeAll(u.id, c);
    await audit(req, 'user.block', 'user', u.id, { reason: b.reason }, c);
  });
  realtime.disconnectUser(u.id);
  res.status(204).end();
});

router.post('/:id/unblock', async (req, res) => {
  const u = await loadUser(req);
  await db.query('UPDATE users SET is_blocked = false, blocked_reason = NULL, blocked_at = NULL WHERE id = $1', [u.id]);
  await audit(req, 'user.unblock', 'user', u.id);
  res.status(204).end();
});

router.post('/:id/logout-all', async (req, res) => {
  const u = await loadUser(req);
  await tokens.revokeAll(u.id);
  realtime.disconnectUser(u.id);
  await audit(req, 'user.logout_all', 'user', u.id);
  res.status(204).end();
});

router.patch('/:id', async (req, res) => {
  const u = await loadUser(req);
  const b = parse(z.object({ fullName: z.string().trim().min(1).max(100).optional(), role: z.enum(['super_admin', 'user']).optional() }), req.body);
  if (b.role === 'user' && u.id === req.user.id) throw E.conflict('CANNOT_DEMOTE_SELF', 'You cannot remove your own admin role');
  const roleChanged = b.role && b.role !== u.role;
  const out = await db.one(
    `UPDATE users SET full_name = COALESCE($2, full_name), role = COALESCE($3, role),
            token_version = token_version + CASE WHEN $4 THEN 1 ELSE 0 END WHERE id = $1 RETURNING *`,
    [u.id, b.fullName ?? null, b.role ?? null, !!roleChanged],
  );
  if (roleChanged) realtime.disconnectUser(u.id);
  await audit(req, 'user.update', 'user', u.id, b);
  res.json(ser.user(out));
});

// Admin sets a new password (no SMS reset yet). Logs the user out everywhere.
router.post('/:id/password', async (req, res) => {
  const u = await loadUser(req);
  const b = parse(z.object({ newPassword: password }), req.body);
  if (u.deleted_at) throw E.conflict('USER_DELETED', 'This account was deleted');
  if (!u.phone) throw E.conflict('NO_PHONE', 'This account has no phone number to log in with');
  await db.tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $2, phone_verified_at = COALESCE(phone_verified_at, now()) WHERE id = $1',
      [u.id, await hashPassword(b.newPassword)]);
    await tokens.revokeAll(u.id, c);
    await audit(req, 'user.password_reset', 'user', u.id, null, c);
  });
  realtime.disconnectUser(u.id);
  res.status(204).end();
});

module.exports = router;
