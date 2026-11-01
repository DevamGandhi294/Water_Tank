// 3. My tanks, 4. settings, 5. pump, 6. timers, 7.1-7.5 sharing, 8. history, 9.3-9.4 alerts
const express = require('express');
const db = require('../db');
const { E } = require('../errors');
const { z, parse, hhmm } = require('../lib/validate');
const { normalizePhone, encodeCursor, decodeCursor, pageLimit, iso } = require('../lib/format');
const { randomToken, claimCodeHash, normalizeClaimCode } = require('../lib/crypto');
const ser = require('../lib/serialize');
const timersLib = require('../lib/timers');
const sms = require('../lib/sms');
const { deviceAccess, can } = require('../services/access');
const views = require('../services/deviceViews');
const live = require('../services/live');
const events = require('../services/events');
const commands = require('../services/commands');
const settingsService = require('../services/settingsService');
const settingsSync = require('../services/settingsSync');
const alerts = require('../services/alerts');
const pumpRuns = require('../services/pumpRuns');
const realtime = require('../services/realtime');
const { limiter } = require('../middleware/rateLimit');

const router = express.Router();

// ---------------------------------------------------------------- 3. tanks
router.get('/', async (req, res) => {
  res.json({ items: await views.listForUser(req.user.id) });
});

const claimLimiter = limiter('claim', { limit: 5, keyFn: (r) => r.user.id, failuresOnly: true });

async function findClaimable(serial, code) {
  const d = await db.one('SELECT * FROM devices WHERE upper(serial_no) = upper($1)', [String(serial || '').trim()]);
  if (!d) throw E.notFound('INVALID_CODE', 'This code is not valid. Check the sticker and try again.');
  if (d.owner_id) throw E.conflict('ALREADY_CLAIMED', 'This tank already belongs to another account. Contact support.');
  if (!d.claim_code_hash || d.claim_code_hash !== claimCodeHash(code)) {
    throw E.notFound('INVALID_CODE', 'This code is not valid. Check the sticker and try again.');
  }
  if (d.is_disabled) throw E.conflict('DEVICE_DISABLED', 'This tank is disabled by support');
  return d;
}

// accepts {serial, claimCode} or {qr: "WT1:<serial>:<code>"}
function claimInput(body) {
  const b = parse(z.object({ serial: z.string().max(40).optional(), claimCode: z.string().max(40).optional(), qr: z.string().max(200).optional() }).passthrough(), body);
  if (b.qr) {
    const m = /^WT1:([^:]+):(.+)$/.exec(b.qr.trim());
    if (!m) throw E.bad('INVALID_QR', 'This QR code is not a Water Tank code', 'qr');
    return { serial: m[1], claimCode: m[2] };
  }
  if (!b.serial || !b.claimCode) throw E.bad('VALIDATION', 'serial and claimCode are required', b.serial ? 'claimCode' : 'serial');
  if (normalizeClaimCode(b.claimCode).length !== 8) throw E.notFound('INVALID_CODE', 'This code is not valid. Check the sticker and try again.');
  return { serial: b.serial, claimCode: b.claimCode };
}

// 3.2
router.post('/claim/check', claimLimiter, async (req, res) => {
  const { serial, claimCode } = claimInput(req.body);
  const d = await findClaimable(serial, claimCode);
  res.json({ serial: d.serial_no, hwModel: d.hw_model, available: true });
});

// 3.3
router.post('/claim', claimLimiter, async (req, res) => {
  const { serial, claimCode } = claimInput(req.body);
  const b = parse(z.object({
    name: z.string().trim().min(1).max(60),
    location: z.string().trim().max(100).optional().nullable(),
    tankHeightCm: z.number().optional().nullable(),
    capacityLitres: z.number().int().positive().optional().nullable(),
  }).passthrough(), req.body);
  const d = await findClaimable(serial, claimCode);
  // tank height / capacity are checked before the device is taken
  if (b.tankHeightCm != null || b.capacityLitres != null) {
    const cur = await db.one('SELECT * FROM device_settings WHERE device_id = $1', [d.id]);
    settingsService.validate(cur, { tankHeightCm: b.tankHeightCm ?? undefined });
  }
  const ok = await db.tx(async (c) => {
    const upd = await c.one(
      `UPDATE devices SET owner_id = $2, claimed_at = now(), claim_code_hash = NULL, name = $3, location = $4
        WHERE id = $1 AND owner_id IS NULL AND claim_code_hash IS NOT NULL RETURNING id`,
      [d.id, req.user.id, b.name, b.location || null],
    );
    if (!upd) return false;
    await events.add(d.id, 'claimed', { message: `Added to ${req.user.full_name}'s account`, data: { userId: req.user.id } }, c);
    return true;
  });
  if (!ok) throw E.conflict('ALREADY_CLAIMED', 'This tank already belongs to another account. Contact support.');
  live.invalidate(d.id);
  if (b.tankHeightCm != null || b.capacityLitres != null) {
    await settingsService.update(d.id, {
      ...(b.tankHeightCm != null ? { tankHeightCm: b.tankHeightCm } : {}),
      ...(b.capacityLitres != null ? { capacityLitres: b.capacityLitres } : {}),
    }, req.user.id);
  }
  res.status(201).json(await views.detail(d.id, 'owner'));
});

// 3.4
router.get('/:id', deviceAccess('view'), async (req, res) => {
  res.json(await views.detail(req.device.id, req.access));
});

// 3.5
router.patch('/:id', deviceAccess('owner'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(60).optional(),
    location: z.union([z.string().trim().max(100), z.null()]).optional(),
    timezone: z.string().max(60).optional(),
  }), req.body);
  if (b.timezone) {
    const ok = await db.one('SELECT 1 FROM pg_timezone_names WHERE name = $1', [b.timezone]);
    if (!ok) throw E.bad('INVALID_TIMEZONE', 'Unknown time zone', 'timezone');
  }
  await db.query(
    `UPDATE devices SET name = COALESCE($2, name), timezone = COALESCE($3, timezone),
            location = CASE WHEN $4::boolean THEN $5 ELSE location END WHERE id = $1`,
    [req.device.id, b.name ?? null, b.timezone ?? null, b.location !== undefined, b.location ?? null],
  );
  live.invalidate(req.device.id);
  res.json(await views.detail(req.device.id, req.access));
});

// release a device from its owner (3.6, admin unclaim, account delete)
async function releaseDevice(deviceId, reason, actorName) {
  const members = await db.tx(async (c) => {
    const d = await c.one('SELECT owner_id FROM devices WHERE id = $1 FOR UPDATE', [deviceId]);
    const m = await c.many('SELECT user_id FROM device_shares WHERE device_id = $1', [deviceId]);
    await c.query('DELETE FROM device_shares WHERE device_id = $1', [deviceId]);
    await c.query('DELETE FROM device_invites WHERE device_id = $1 AND accepted_at IS NULL', [deviceId]);
    await c.query('DELETE FROM timers WHERE device_id = $1', [deviceId]);
    await c.query('DELETE FROM alert_settings WHERE device_id = $1', [deviceId]);
    await c.query('UPDATE devices SET owner_id = NULL, claimed_at = NULL, claim_code_hash = NULL WHERE id = $1', [deviceId]);
    await events.add(deviceId, 'unclaimed', { message: `Removed from account${actorName ? ` by ${actorName}` : ''}`, data: { reason } }, c);
    return d && d.owner_id ? [...m.map((x) => x.user_id), d.owner_id] : m.map((x) => x.user_id);
  });
  live.invalidate(deviceId);
  members.forEach((u) => realtime.removeFromDevice(u, deviceId));
}

// 3.6
router.delete('/:id', deviceAccess('owner'), async (req, res) => {
  if (req.access === 'admin' && req.device.owner_id !== req.user.id) throw E.forbidden('NOT_ALLOWED', 'Use the admin unclaim action');
  await releaseDevice(req.device.id, 'owner_removed', req.user.full_name);
  res.status(204).end();
});

// 3.7 leave a shared tank
router.delete('/:id/me', deviceAccess('view'), async (req, res) => {
  if (req.access === 'owner') throw E.conflict('OWNER_CANNOT_LEAVE', 'The owner removes the tank instead');
  await db.query('DELETE FROM device_shares WHERE device_id = $1 AND user_id = $2', [req.device.id, req.user.id]);
  realtime.removeFromDevice(req.user.id, req.device.id);
  res.status(204).end();
});

// ---------------------------------------------------------------- 4. settings
router.get('/:id/settings', deviceAccess('view'), async (req, res) => {
  const s = await db.one('SELECT * FROM device_settings WHERE device_id = $1', [req.device.id]);
  const st = await live.stateFor(req.device.id);
  res.json(ser.settings(s, st && st.is_online));
});

router.patch('/:id/settings', deviceAccess('owner'), async (req, res) => {
  res.json(await settingsService.update(req.device.id, req.body, req.user.id));
});

router.get('/:id/settings/history', deviceAccess('owner'), async (req, res) => {
  res.json({ items: await settingsService.history(req.device.id, pageLimit(req.query.limit, 50, 200)) });
});

// ---------------------------------------------------------------- 5. pump
async function pumpPreflight(device, action) {
  if (device.is_disabled) throw E.conflict('DEVICE_DISABLED', 'This tank is disabled by support');
  const st = await live.stateFor(device.id);
  if (!st || !st.is_online) throw E.conflict('DEVICE_OFFLINE', 'The tank is offline');
  if (action === 'on') {
    const s = await db.one('SELECT cutoff_distance_cm, auto_mode FROM device_settings WHERE device_id = $1', [device.id]);
    if (st.distance_cm !== null && st.distance_cm <= s.cutoff_distance_cm) throw E.conflict('TANK_FULL', 'The tank is already full');
    if (s.auto_mode && (st.status === 'FAULT' || st.status === 'DOWN')) {
      throw E.conflict('SENSOR_FAULT', 'The level sensor is not working, so the pump cannot be switched on');
    }
  }
  return st;
}

router.post('/:id/pump', deviceAccess('control'), limiter('pump', { limit: 30, windowMs: 60_000, keyFn: (r) => r.params.id }), async (req, res) => {
  const b = parse(z.object({ action: z.enum(['on', 'off']) }), req.body);
  await pumpPreflight(req.device, b.action);
  const c = await commands.send(req.device, b.action === 'on' ? 'pump_on' : 'pump_off', {
    source: req.access === 'admin' ? 'admin' : 'app', userId: req.user.id,
  });
  if (c.status === 'failed') throw E.conflict('DEVICE_OFFLINE', 'Could not reach the tank, try again');
  res.status(202).json({ commandId: c.id, status: c.status });
});

router.get('/:id/commands/:commandId', deviceAccess('control'), async (req, res) => {
  const id = parseInt(req.params.commandId, 10);
  const c = Number.isFinite(id) ? await db.one('SELECT * FROM device_commands WHERE id = $1 AND device_id = $2', [id, req.device.id]) : null;
  if (!c) throw E.notFound('COMMAND_NOT_FOUND', 'Command not found');
  res.json({ id: c.id, type: c.type, status: c.status, error: c.error, createdAt: iso(c.created_at), ackedAt: iso(c.acked_at) });
});

// ---------------------------------------------------------------- 6. timers
const timerBody = z.object({
  name: z.union([z.string().trim().max(40), z.null()]).optional(),
  startTime: hhmm,
  stopTime: hhmm,
  days: z.array(z.enum(timersLib.DAYS)).min(1).max(7),
  onlyIfBelowPct: z.union([z.number().int().min(1).max(100), z.null()]).optional(),
  enabled: z.boolean().optional(),
});

router.get('/:id/timers', deviceAccess('view'), async (req, res) => {
  const rows = await db.many('SELECT * FROM timers WHERE device_id = $1 ORDER BY start_time, id', [req.device.id]);
  res.json({ items: rows.map((t) => timersLib.serialize(t, req.device.timezone)) });
});

router.post('/:id/timers', deviceAccess('control'), async (req, res) => {
  const b = parse(timerBody, req.body);
  if (b.startTime === b.stopTime) throw E.invalid('TIMER_START_EQUALS_STOP', 'Start and stop time must be different', 'stopTime');
  const n = await db.one('SELECT count(*)::int AS n FROM timers WHERE device_id = $1', [req.device.id]);
  if (n.n >= 8) throw E.invalid('TOO_MANY_TIMERS', 'A tank can have at most 8 timers');
  const t = await db.one(
    `INSERT INTO timers (device_id, created_by, name, start_time, stop_time, days_mask, only_if_below_pct, is_enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.device.id, req.user.id, b.name || null, b.startTime, b.stopTime, timersLib.daysToMask(b.days),
      b.onlyIfBelowPct ?? null, b.enabled ?? true],
  );
  res.status(201).json(timersLib.serialize(t, req.device.timezone));
});

async function loadTimer(req) {
  const id = parseInt(req.params.timerId, 10);
  const t = Number.isFinite(id) ? await db.one('SELECT * FROM timers WHERE id = $1 AND device_id = $2', [id, req.device.id]) : null;
  if (!t) throw E.notFound('TIMER_NOT_FOUND', 'Timer not found');
  return t;
}

router.patch('/:id/timers/:timerId', deviceAccess('control'), async (req, res) => {
  const cur = await loadTimer(req);
  const b = parse(timerBody.partial(), req.body);
  const start = b.startTime ?? timersLib.hhmm(cur.start_time);
  const stop = b.stopTime ?? timersLib.hhmm(cur.stop_time);
  if (start === stop) throw E.invalid('TIMER_START_EQUALS_STOP', 'Start and stop time must be different', 'stopTime');
  const t = await db.one(
    `UPDATE timers SET name = CASE WHEN $2::boolean THEN $3 ELSE name END, start_time = $4, stop_time = $5,
            days_mask = COALESCE($6, days_mask),
            only_if_below_pct = CASE WHEN $7::boolean THEN $8 ELSE only_if_below_pct END,
            is_enabled = COALESCE($9, is_enabled)
      WHERE id = $1 RETURNING *`,
    [cur.id, b.name !== undefined, b.name || null, start, stop, b.days ? timersLib.daysToMask(b.days) : null,
      b.onlyIfBelowPct !== undefined, b.onlyIfBelowPct ?? null, b.enabled ?? null],
  );
  res.json(timersLib.serialize(t, req.device.timezone));
});

router.delete('/:id/timers/:timerId', deviceAccess('control'), async (req, res) => {
  const t = await loadTimer(req);
  await db.query('DELETE FROM timers WHERE id = $1', [t.id]);
  res.status(204).end();
});

// ---------------------------------------------------------------- 7. sharing (owner side)
const inviteOut = (i) => ({ id: i.id, phone: i.phone, permission: i.permission, expiresAt: iso(i.expires_at), createdAt: iso(i.created_at) });

router.get('/:id/members', deviceAccess('owner'), async (req, res) => {
  const owner = req.device.owner_id ? await db.one('SELECT * FROM users WHERE id = $1', [req.device.owner_id]) : null;
  const members = await db.many(
    `SELECT s.user_id, s.permission, s.created_at, u.full_name, u.phone FROM device_shares s
       JOIN users u ON u.id = s.user_id WHERE s.device_id = $1 ORDER BY s.created_at`,
    [req.device.id],
  );
  const invites = await db.many(
    `SELECT * FROM device_invites WHERE device_id = $1 AND accepted_at IS NULL AND declined_at IS NULL
        AND expires_at > now() ORDER BY created_at`,
    [req.device.id],
  );
  res.json({
    owner: ser.user(owner),
    members: members.map((m) => ({ userId: m.user_id, fullName: m.full_name, phone: m.phone, permission: m.permission, since: iso(m.created_at) })),
    invites: invites.map(inviteOut),
  });
});

router.post('/:id/invites', deviceAccess('owner'), limiter('invite', { limit: 20, keyFn: (r) => r.params.id }), async (req, res) => {
  const b = parse(z.object({ phone: z.string(), permission: z.enum(['view', 'control']) }), req.body);
  const phone = normalizePhone(b.phone);
  const owner = req.device.owner_id && await db.one('SELECT full_name, phone FROM users WHERE id = $1', [req.device.owner_id]);
  if (owner && owner.phone === phone) throw E.conflict('IS_OWNER', 'This is the owner’s own number', 'phone');
  const member = await db.one(
    `SELECT 1 FROM device_shares s JOIN users u ON u.id = s.user_id WHERE s.device_id = $1 AND u.phone = $2`,
    [req.device.id, phone],
  );
  if (member) throw E.conflict('ALREADY_MEMBER', 'This person already has access', 'phone');
  const inv = await db.tx(async (c) => {
    await c.query(`DELETE FROM device_invites WHERE device_id = $1 AND phone = $2 AND accepted_at IS NULL`, [req.device.id, phone]);
    return c.one(
      `INSERT INTO device_invites (device_id, phone, permission, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING *`,
      [req.device.id, phone, b.permission, require('../lib/crypto').sha256(randomToken()), req.user.id],
    );
  });
  const invitee = await db.one('SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL', [phone]);
  const deviceName = req.device.name || req.device.serial_no;
  if (invitee) {
    realtime.toUser(invitee.id, 'invite', {
      invite: { id: inv.id, deviceName, ownerName: owner ? owner.full_name : null, permission: inv.permission, expiresAt: iso(inv.expires_at) },
    });
  } else {
    await sms.sendInvite(phone, owner ? owner.full_name : 'Someone', deviceName);
  }
  res.status(201).json({ ...inviteOut(inv), hasAccount: !!invitee });
});

router.delete('/:id/invites/:inviteId', deviceAccess('owner'), async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.inviteId)) throw E.notFound('INVITE_NOT_FOUND', 'Invite not found');
  const r = await db.query('DELETE FROM device_invites WHERE id = $1 AND device_id = $2 AND accepted_at IS NULL', [req.params.inviteId, req.device.id]);
  if (!r.rowCount) throw E.notFound('INVITE_NOT_FOUND', 'Invite not found');
  res.status(204).end();
});

router.patch('/:id/members/:userId', deviceAccess('owner'), async (req, res) => {
  const b = parse(z.object({ permission: z.enum(['view', 'control']) }), req.body);
  if (!/^[0-9a-f-]{36}$/i.test(req.params.userId)) throw E.notFound('MEMBER_NOT_FOUND', 'Member not found');
  const m = await db.one(
    `UPDATE device_shares SET permission = $3 WHERE device_id = $1 AND user_id = $2 RETURNING *`,
    [req.device.id, req.params.userId, b.permission],
  );
  if (!m) throw E.notFound('MEMBER_NOT_FOUND', 'Member not found');
  const u = await db.one('SELECT full_name, phone FROM users WHERE id = $1', [m.user_id]);
  realtime.accessChanged(m.user_id, req.device.id, m.permission);
  res.json({ userId: m.user_id, fullName: u.full_name, phone: u.phone, permission: m.permission, since: iso(m.created_at) });
});

router.delete('/:id/members/:userId', deviceAccess('owner'), async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.userId)) throw E.notFound('MEMBER_NOT_FOUND', 'Member not found');
  const r = await db.query('DELETE FROM device_shares WHERE device_id = $1 AND user_id = $2', [req.device.id, req.params.userId]);
  if (!r.rowCount) throw E.notFound('MEMBER_NOT_FOUND', 'Member not found');
  realtime.removeFromDevice(req.params.userId, req.device.id);
  res.status(204).end();
});

// ---------------------------------------------------------------- 8. history
function parseDate(v, field) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw E.bad('INVALID_DATE', `${field} must be an ISO date`, field);
  return d;
}

router.get('/:id/pump-runs', deviceAccess('view'), async (req, res) => {
  const limit = pageLimit(req.query.limit);
  const from = parseDate(req.query.from, 'from');
  const to = parseDate(req.query.to, 'to');
  const cur = decodeCursor(req.query.cursor);
  const rows = await db.many(
    `${pumpRuns.SELECT_RUN}
      WHERE r.device_id = $1 AND ($2::timestamptz IS NULL OR r.started_at >= $2) AND ($3::timestamptz IS NULL OR r.started_at < $3)
        AND ($4::timestamptz IS NULL OR (r.started_at, r.id) < ($4, $5))
      ORDER BY r.started_at DESC, r.id DESC LIMIT $6`,
    [req.device.id, from, to, cur ? cur.t : null, cur ? cur.id : 0, limit + 1],
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  res.json({
    items: items.map(pumpRuns.serialize),
    nextCursor: more ? encodeCursor({ t: last.started_at, id: last.id }) : null,
  });
});

// run time per bucket in the device time zone: day = 24 hourly buckets, week = 7 days, month = 30 days
router.get('/:id/pump-runs/summary', deviceAccess('view'), async (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'week';
  const unit = period === 'day' ? 'hour' : 'day';
  const count = period === 'day' ? 24 : period === 'week' ? 7 : 30;
  const rows = await db.many(
    `WITH b AS (
       SELECT gs AS local_start, gs + ('1 ' || $3)::interval AS local_end
         FROM generate_series(date_trunc($3, now() AT TIME ZONE $2) - (($4 - 1) || ' ' || $3)::interval,
                              date_trunc($3, now() AT TIME ZONE $2), ('1 ' || $3)::interval) gs
     )
     SELECT to_char(b.local_start, CASE WHEN $3 = 'hour' THEN 'YYYY-MM-DD"T"HH24:00' ELSE 'YYYY-MM-DD' END) AS date,
            count(r.id)::int AS runs,
            -- r.id IS NULL = empty bucket (GREATEST/LEAST skip NULLs, so guard explicitly)
            COALESCE(sum(CASE WHEN r.id IS NULL THEN 0 ELSE
                       EXTRACT(EPOCH FROM (LEAST(COALESCE(r.ended_at, now()), b.local_end AT TIME ZONE $2)
                                         - GREATEST(r.started_at, b.local_start AT TIME ZONE $2))) END), 0)::int AS total_s
       FROM b LEFT JOIN pump_runs r ON r.device_id = $1
            AND r.started_at < b.local_end AT TIME ZONE $2
            AND COALESCE(r.ended_at, now()) > b.local_start AT TIME ZONE $2
      GROUP BY b.local_start ORDER BY b.local_start`,
    [req.device.id, req.device.timezone, unit, count],
  );
  const buckets = rows.map((r) => ({ date: r.date, runs: r.runs, totalS: r.total_s }));
  res.json({
    period,
    timezone: req.device.timezone,
    buckets,
    totalS: buckets.reduce((a, x) => a + x.totalS, 0),
    runs: buckets.reduce((a, x) => a + x.runs, 0),
  });
});

router.get('/:id/events', deviceAccess('view'), async (req, res) => {
  const limit = pageLimit(req.query.limit);
  const sev = req.query.severity ? String(req.query.severity).split(',').filter((s) => ['info', 'warning', 'critical'].includes(s)) : null;
  const types = req.query.type ? String(req.query.type).split(',').filter((s) => /^[a-z_]+$/.test(s)) : null;
  const cur = decodeCursor(req.query.cursor);
  const rows = await db.many(
    `SELECT * FROM device_events WHERE device_id = $1
        AND ($2::event_severity[] IS NULL OR severity = ANY($2))
        AND ($3::text[] IS NULL OR type::text = ANY($3))
        AND ($4::timestamptz IS NULL OR (occurred_at, id) < ($4, $5))
      ORDER BY occurred_at DESC, id DESC LIMIT $6`,
    [req.device.id, sev && sev.length ? sev : null, types && types.length ? types : null, cur ? cur.t : null, cur ? cur.id : 0, limit + 1],
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  res.json({ items: items.map(ser.event), nextCursor: more ? encodeCursor({ t: last.occurred_at, id: last.id }) : null });
});

// ---------------------------------------------------------------- 9.3 / 9.4 my alerts for this tank
async function myAlerts(deviceId, userId) {
  const s = await db.one('SELECT * FROM device_settings WHERE device_id = $1', [deviceId]);
  const rows = await db.many('SELECT * FROM alert_settings WHERE device_id = $1 AND user_id = $2', [deviceId, userId]);
  const by = Object.fromEntries(rows.map((r) => [r.type, r]));
  return alerts.TYPES.map((type) => {
    const r = by[type];
    return {
      type,
      enabled: r ? r.is_enabled : true,
      threshold: r && r.threshold != null ? r.threshold : alerts.defaultThreshold(type, s),
      quietFrom: r && r.quiet_from ? timersLib.hhmm(r.quiet_from) : null,
      quietTo: r && r.quiet_to ? timersLib.hhmm(r.quiet_to) : null,
    };
  });
}

router.get('/:id/alerts', deviceAccess('view'), async (req, res) => {
  res.json(await myAlerts(req.device.id, req.user.id));
});

router.put('/:id/alerts', deviceAccess('view'), async (req, res) => {
  const items = parse(z.array(z.object({
    type: z.enum(alerts.TYPES),
    enabled: z.boolean(),
    threshold: z.union([z.number().int().min(0).max(1440), z.null()]).optional(),
    quietFrom: z.union([hhmm, z.null()]).optional(),
    quietTo: z.union([hhmm, z.null()]).optional(),
  })).max(alerts.TYPES.length), req.body);
  for (const a of items) {
    if ((a.type === 'tank_full' || a.type === 'tank_low') && a.threshold != null && a.threshold > 100) {
      throw E.invalid('THRESHOLD_INVALID', 'Level alerts are 0-100 %', 'threshold');
    }
  }
  await db.tx(async (c) => {
    for (const a of items) {
      await c.query(
        `INSERT INTO alert_settings (user_id, device_id, type, is_enabled, threshold, quiet_from, quiet_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, device_id, type) DO UPDATE SET is_enabled = EXCLUDED.is_enabled,
           threshold = EXCLUDED.threshold, quiet_from = EXCLUDED.quiet_from, quiet_to = EXCLUDED.quiet_to`,
        [req.user.id, req.device.id, a.type, a.enabled, a.threshold ?? null, a.quietFrom || null, a.quietTo || null],
      );
    }
  });
  res.json(await myAlerts(req.device.id, req.user.id));
});

module.exports = { router, releaseDevice, pumpPreflight, can, settingsSync };
