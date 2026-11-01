// /admin: super_admin only. 10.1, 10.2, 10.31 here; devices, users, firmware in their files.
const express = require('express');
const db = require('../../db');
const { iso, pageLimit, decodeCursor, encodeCursor } = require('../../lib/format');
const { requireAdmin } = require('../../middleware/auth');
const ser = require('../../lib/serialize');

const router = express.Router();
router.use(requireAdmin);

async function stats() {
  const s = await db.one('SELECT * FROM admin_stats');
  const fw = await db.many(
    `SELECT COALESCE(fw_version, 'unknown') AS version, count(*)::int AS count FROM device_boards
      WHERE role = 'main' AND replaced_at IS NULL GROUP BY 1 ORDER BY 2 DESC`,
  );
  const openFaults = await db.one(`SELECT count(*)::int AS n FROM device_events WHERE severity <> 'info' AND resolved_at IS NULL`);
  return {
    totalDevices: s.total_devices, claimedDevices: s.claimed_devices, onlineDevices: s.online_devices,
    faultyDevices: s.faulty_devices, activeUsers: s.active_users, usersActive30d: s.users_active_30d,
    openEvents: openFaults.n, fwVersions: fw,
  };
}

router.get('/stats', async (_req, res) => res.json(await stats()));

router.get('/events', async (req, res) => {
  const limit = pageLimit(req.query.limit, 20, 200);
  const sev = String(req.query.severity || 'warning,critical').split(',').filter((s) => ['info', 'warning', 'critical'].includes(s));
  const openOnly = req.query.open !== 'false';
  const rows = await db.many(
    `SELECT e.*, d.serial_no, d.name AS device_name, u.full_name AS owner_name, u.phone AS owner_phone
       FROM device_events e JOIN devices d ON d.id = e.device_id LEFT JOIN users u ON u.id = d.owner_id
      WHERE e.severity = ANY($1::event_severity[]) AND (NOT $2 OR e.resolved_at IS NULL)
      ORDER BY e.occurred_at DESC LIMIT $3`,
    [sev.length ? sev : ['warning', 'critical'], openOnly, limit],
  );
  res.json({
    items: rows.map((e) => ({
      ...ser.event(e), deviceId: e.device_id, serial: e.serial_no, deviceName: e.device_name,
      owner: e.owner_name ? { fullName: e.owner_name, phone: e.owner_phone } : null,
    })),
  });
});

router.get('/audit', async (req, res) => {
  const limit = pageLimit(req.query.limit, 50, 200);
  const cur = decodeCursor(req.query.cursor);
  const rows = await db.many(
    `SELECT a.*, u.full_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ($1::uuid IS NULL OR a.actor_id = $1) AND ($2::text IS NULL OR a.action LIKE $2 || '%')
        AND ($3::text IS NULL OR a.target_id = $3) AND ($4::bigint IS NULL OR a.id < $4)
      ORDER BY a.id DESC LIMIT $5`,
    [/^[0-9a-f-]{36}$/i.test(req.query.actor || '') ? req.query.actor : null, req.query.action || null,
      req.query.target || null, cur ? cur.id : null, limit + 1],
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  res.json({
    items: items.map((a) => ({ id: a.id, actorId: a.actor_id, actorName: a.actor_name, action: a.action, targetType: a.target_type, targetId: a.target_id, data: a.data, ip: a.ip, createdAt: iso(a.created_at) })),
    nextCursor: more ? encodeCursor({ id: items[items.length - 1].id }) : null,
  });
});

router.use('/devices', require('./devices'));
router.use('/users', require('./users'));
router.use('/', require('./firmware'));

module.exports = { router, stats };
