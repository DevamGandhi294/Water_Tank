// 7.6 - 7.8 invites for the person being invited (matched by their verified phone)
const express = require('express');
const db = require('../db');
const { E } = require('../errors');
const { iso } = require('../lib/format');
const views = require('../services/deviceViews');
const realtime = require('../services/realtime');
const events = require('../services/events');

const router = express.Router();

async function myInvite(req) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw E.notFound('INVITE_NOT_FOUND', 'Invite not found');
  const inv = await db.one(
    `SELECT i.*, d.owner_id FROM device_invites i JOIN devices d ON d.id = i.device_id
      WHERE i.id = $1 AND i.phone = $2 AND i.accepted_at IS NULL AND i.declined_at IS NULL`,
    [req.params.id, req.user.phone],
  );
  if (!inv || !req.user.phone) throw E.notFound('INVITE_NOT_FOUND', 'Invite not found');
  if (new Date(inv.expires_at) < new Date()) throw E.conflict('INVITE_EXPIRED', 'This invite has expired. Ask the owner to send a new one.');
  return inv;
}

router.get('/', async (req, res) => {
  if (!req.user.phone) return res.json({ items: [] });
  const rows = await db.many(
    `SELECT i.id, i.permission, i.expires_at, COALESCE(d.name, d.serial_no) AS device_name, u.full_name AS owner_name
       FROM device_invites i JOIN devices d ON d.id = i.device_id LEFT JOIN users u ON u.id = d.owner_id
      WHERE i.phone = $1 AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.expires_at > now()
        AND d.owner_id IS NOT NULL AND d.owner_id <> $2
      ORDER BY i.created_at DESC`,
    [req.user.phone, req.user.id],
  );
  res.json({ items: rows.map((r) => ({ id: r.id, deviceName: r.device_name, ownerName: r.owner_name, permission: r.permission, expiresAt: iso(r.expires_at) })) });
});

router.post('/:id/accept', async (req, res) => {
  const inv = await myInvite(req);
  if (!inv.owner_id) throw E.conflict('INVITE_EXPIRED', 'This tank is no longer shared');
  if (inv.owner_id === req.user.id) throw E.conflict('IS_OWNER', 'You already own this tank');
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO device_shares (device_id, user_id, permission, invited_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (device_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
      [inv.device_id, req.user.id, inv.permission, inv.invited_by],
    );
    await c.query('UPDATE device_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [inv.id, req.user.id]);
  });
  realtime.accessChanged(req.user.id, inv.device_id, inv.permission);
  realtime.toUser(inv.owner_id, 'device:members', { deviceId: inv.device_id });
  res.json(await views.cardFor(inv.device_id, inv.permission));
});

router.post('/:id/decline', async (req, res) => {
  const inv = await myInvite(req);
  await db.query('UPDATE device_invites SET declined_at = now() WHERE id = $1', [inv.id]);
  if (inv.owner_id) realtime.toUser(inv.owner_id, 'device:members', { deviceId: inv.device_id });
  res.status(204).end();
});

module.exports = router;
