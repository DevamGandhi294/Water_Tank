// 10.3 - 10.15 admin: devices
const express = require('express');
const db = require('../../db');
const { E } = require('../../errors');
const { z, parse } = require('../../lib/validate');
const { normalizeMac, macToUsername, macOut, normalizePhone, iso, pageLimit, decodeCursor, encodeCursor } = require('../../lib/format');
const { claimCode, claimCodeHash } = require('../../lib/crypto');
const { qrPayload, qrPngBase64, stickerSheetHtml } = require('../../lib/qr');
const { audit } = require('../../lib/audit');
const ser = require('../../lib/serialize');
const views = require('../../services/deviceViews');
const live = require('../../services/live');
const events = require('../../services/events');
const commands = require('../../services/commands');
const mqtt = require('../../services/mqtt');
const realtime = require('../../services/realtime');
const settingsService = require('../../services/settingsService');
const settingsSync = require('../../services/settingsSync');
const { releaseDevice } = require('../devices');
const { forget: forgetMqttLogin } = require('../mqttAuth');

const router = express.Router();

const registerBody = z.object({
  macMain: z.string(),
  macSender: z.string(),
  hwModel: z.string().trim().min(1).max(40).optional(),
  manufacturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional().nullable(),
  serial: z.string().trim().regex(/^[A-Z0-9-]{4,30}$/i, 'letters, digits and - only').optional(),
});

// Creates the device, its two boards, settings and state rows. Returns the one-time values.
async function registerDevice(input, req) {
  const b = parse(registerBody, input);
  const macMain = normalizeMac(b.macMain, 'macMain');
  const macSender = normalizeMac(b.macSender, 'macSender');
  if (macMain === macSender) throw E.bad('SAME_MAC', 'Main and sender MAC must be different', 'macSender');
  const code = claimCode();

  const device = await db.tx(async (c) => {
    // one registration at a time, so serial numbers never collide
    await c.query('SELECT pg_advisory_xact_lock(4242)');
    const dup = await c.one(
      `SELECT b.mac, d.serial_no FROM device_boards b JOIN devices d ON d.id = b.device_id
        WHERE b.mac = ANY($1::macaddr[]) LIMIT 1`,
      [[macMain, macSender]],
    );
    if (dup) {
      throw E.conflict('MAC_EXISTS', `This MAC is already registered to ${dup.serial_no}`, macOut(dup.mac) === macMain ? 'macMain' : 'macSender');
    }
    let serial = b.serial ? b.serial.toUpperCase() : null;
    if (serial) {
      if (await c.one('SELECT 1 FROM devices WHERE serial_no = $1', [serial])) throw E.conflict('SERIAL_EXISTS', 'This serial number is taken', 'serial');
    } else {
      const year = new Date().getUTCFullYear();
      const r = await c.one(
        `SELECT COALESCE(max(substring(serial_no from '^WT-\\d{4}-(\\d+)$')::int), 0) AS n FROM devices WHERE serial_no LIKE $1`,
        [`WT-${year}-%`],
      );
      serial = `WT-${year}-${String(r.n + 1).padStart(5, '0')}`;
    }
    const username = macToUsername(macMain);
    if (await c.one('SELECT 1 FROM devices WHERE mqtt_username = $1', [username])) {
      throw E.conflict('MAC_EXISTS', 'This main board MAC was registered before', 'macMain');
    }
    const d = await c.one(
      `INSERT INTO devices (serial_no, mqtt_username, claim_code_hash, hw_model, registered_by, manufactured_at)
       VALUES ($1,$2,$3,COALESCE($4,'WT-ESP8266-HC12'),$5,$6) RETURNING *`,
      [serial, username, claimCodeHash(code), b.hwModel || null, req.user.id, b.manufacturedAt || null],
    );
    await c.query(`INSERT INTO device_boards (device_id, role, mac) VALUES ($1,'main',$2), ($1,'sender',$3)`, [d.id, macMain, macSender]);
    await c.query('INSERT INTO device_settings (device_id) VALUES ($1)', [d.id]);
    await c.query('INSERT INTO device_state (device_id) VALUES ($1)', [d.id]);
    await audit(req, 'device.register', 'device', d.id, { serial, macMain, macSender }, c);
    return d;
  });
  // retained settings, so the ESP gets cutoff 25 cm the first time it connects
  await settingsSync.publish(device.id);
  const qr = qrPayload(device.serial_no, code);
  return {
    device: await views.detail(device.id, 'admin'),
    serial: device.serial_no,
    mqttUsername: device.mqtt_username,
    claimCode: code,
    qrPayload: qr,
    qrPngBase64: await qrPngBase64(qr),
  };
}

// 10.3 list / search
router.get('/', async (req, res) => {
  const limit = pageLimit(req.query.limit, 50, 200);
  const offset = (decodeCursor(req.query.cursor) || {}).o || 0;
  const q = req.query.q ? String(req.query.q).trim() : null;
  const qMac = q ? q.replace(/[:\-\s]/g, '').toLowerCase() : null;
  const statusF = req.query.status ? String(req.query.status).toUpperCase() : null;
  const online = req.query.online === 'true' ? true : req.query.online === 'false' ? false : null;
  const claimed = req.query.claimed === 'true' ? true : req.query.claimed === 'false' ? false : null;
  const fw = req.query.fw ? String(req.query.fw) : null;
  const where = `
      ($1::text IS NULL OR d.serial_no ILIKE '%' || $1 || '%' OR d.name ILIKE '%' || $1 || '%'
        OR o.full_name ILIKE '%' || $1 || '%' OR (length(regexp_replace($1, '[^0-9]', '', 'g')) >= 3 AND o.phone LIKE '%' || regexp_replace($1, '[^0-9]', '', 'g') || '%')
        OR ($2::text ~ '^[0-9a-f]{2,12}$' AND EXISTS (SELECT 1 FROM device_boards b WHERE b.device_id = d.id
              AND replace(b.mac::text, ':', '') LIKE '%' || $2 || '%')))
      AND ($3::text IS NULL OR ($3 = 'OFFLINE' AND NOT COALESCE(s.is_online, false))
                            OR ($3 <> 'OFFLINE' AND s.is_online AND s.status::text = $3))
      AND ($4::boolean IS NULL OR COALESCE(s.is_online, false) = $4)
      AND ($5::boolean IS NULL OR (d.owner_id IS NOT NULL) = $5)
      AND ($6::text IS NULL OR bm.fw_version = $6 OR ($6 = 'unknown' AND bm.fw_version IS NULL))`;
  const from = `FROM devices d
      LEFT JOIN users o ON o.id = d.owner_id
      LEFT JOIN device_state s ON s.device_id = d.id
      LEFT JOIN device_boards bm ON bm.device_id = d.id AND bm.role = 'main' AND bm.replaced_at IS NULL
      LEFT JOIN device_boards bs ON bs.device_id = d.id AND bs.role = 'sender' AND bs.replaced_at IS NULL`;
  const params = [q, qMac && qMac.length ? qMac : null, statusF, online, claimed, fw];
  const [rows, total] = await Promise.all([
    db.many(
      `SELECT d.*, o.full_name AS owner_name, o.phone AS owner_phone, bm.mac AS mac_main, bs.mac AS mac_sender,
              bm.fw_version AS fw_main, s.is_online, s.status, s.pump_on, s.distance_cm, s.level_pct, s.last_seen_at
         ${from} WHERE ${where} ORDER BY d.created_at DESC, d.id LIMIT $7 OFFSET $8`,
      [...params, limit + 1, offset],
    ),
    db.one(`SELECT count(*)::int AS n ${from} WHERE ${where}`, params),
  ]);
  const more = rows.length > limit;
  res.json({
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      serial: r.serial_no,
      macMain: macOut(r.mac_main),
      macSender: macOut(r.mac_sender),
      owner: r.owner_id ? { id: r.owner_id, fullName: r.owner_name, phone: r.owner_phone } : null,
      name: r.name,
      location: r.location,
      state: ser.stateCard(r),
      fwVersion: r.fw_main,
      isDisabled: r.is_disabled,
      createdAt: iso(r.created_at),
    })),
    total: total.n,
    nextCursor: more ? encodeCursor({ o: offset + limit }) : null,
  });
});

// 10.4 register one
router.post('/', async (req, res) => {
  res.status(201).json(await registerDevice(req.body, req));
});

// 10.5 bulk (CSV rows parsed by the admin panel)
router.post('/bulk', async (req, res) => {
  const b = parse(z.object({ rows: z.array(z.object({ macMain: z.string(), macSender: z.string() }).passthrough()).min(1).max(500) }), req.body);
  const results = [];
  for (const [i, row] of b.rows.entries()) {
    try {
      const r = await registerDevice(row, req);
      results.push({ row: i + 1, ok: true, serial: r.serial, deviceId: r.device.id, mqttUsername: r.mqttUsername, claimCode: r.claimCode, qrPayload: r.qrPayload, qrPngBase64: r.qrPngBase64 });
    } catch (err) {
      results.push({ row: i + 1, ok: false, macMain: row.macMain, macSender: row.macSender, error: { code: err.code || 'ERROR', message: err.message } });
    }
  }
  const okRows = results.filter((r) => r.ok);
  res.status(201).json({ results, created: okRows.length, failed: results.length - okRows.length, stickerSheetHtml: okRows.length ? stickerSheetHtml(okRows) : null });
});

async function loadDevice(req) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw E.notFound('DEVICE_NOT_FOUND', 'Device not found');
  const d = await db.one('SELECT * FROM devices WHERE id = $1', [req.params.id]);
  if (!d) throw E.notFound('DEVICE_NOT_FOUND', 'Device not found');
  return d;
}

// 10.6 full detail
router.get('/:id', async (req, res) => {
  const d = await loadDevice(req);
  const [detail, owner, members, ev, cmds, otaHist, settingsHistory, allBoards] = await Promise.all([
    views.detail(d.id, 'admin'),
    d.owner_id ? db.one('SELECT * FROM users WHERE id = $1', [d.owner_id]) : null,
    db.many(`SELECT s.user_id, s.permission, s.created_at, u.full_name, u.phone FROM device_shares s JOIN users u ON u.id = s.user_id
              WHERE s.device_id = $1 ORDER BY s.created_at`, [d.id]),
    db.many('SELECT * FROM device_events WHERE device_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 20', [d.id]),
    db.many(`SELECT c.*, u.full_name AS by_name FROM device_commands c LEFT JOIN users u ON u.id = c.requested_by
              WHERE c.device_id = $1 ORDER BY c.created_at DESC LIMIT 20`, [d.id]),
    db.many(`SELECT od.*, f.version FROM ota_rollout_devices od JOIN ota_rollouts o ON o.id = od.rollout_id
              JOIN firmware_releases f ON f.id = o.release_id WHERE od.device_id = $1 ORDER BY od.updated_at DESC LIMIT 20`, [d.id]),
    settingsService.history(d.id, 20),
    db.many('SELECT * FROM device_boards WHERE device_id = $1 ORDER BY created_at', [d.id]),
  ]);
  res.json({
    ...detail,
    mqttUsername: d.mqtt_username,
    createdAt: iso(d.created_at),
    manufacturedAt: d.manufactured_at,
    claimCodeActive: !!d.claim_code_hash,
    owner: ser.user(owner),
    members: members.map((m) => ({ userId: m.user_id, fullName: m.full_name, phone: m.phone, permission: m.permission, since: iso(m.created_at) })),
    events: ev.map(ser.event),
    commands: cmds.map((c) => ({ id: c.id, type: c.type, source: c.source, requestedBy: c.by_name, status: c.status, error: c.error, createdAt: iso(c.created_at), ackedAt: iso(c.acked_at) })),
    otaHistory: otaHist.map((o) => ({ rolloutId: o.rollout_id, version: o.version, status: o.status, fromVersion: o.from_version, error: o.error, updatedAt: iso(o.updated_at) })),
    settingsHistory,
    boardHistory: allBoards.map((b) => ({ ...ser.board(b), replacedAt: iso(b.replaced_at), createdAt: iso(b.created_at) })),
  });
});

// 10.7 edit / disable
router.patch('/:id', async (req, res) => {
  const d = await loadDevice(req);
  const b = parse(z.object({
    name: z.union([z.string().trim().max(60), z.null()]).optional(),
    location: z.union([z.string().trim().max(100), z.null()]).optional(),
    hwModel: z.string().trim().min(1).max(40).optional(),
    isDisabled: z.boolean().optional(),
  }), req.body);
  await db.query(
    `UPDATE devices SET name = CASE WHEN $2::boolean THEN $3 ELSE name END,
            location = CASE WHEN $4::boolean THEN $5 ELSE location END,
            hw_model = COALESCE($6, hw_model), is_disabled = COALESCE($7, is_disabled) WHERE id = $1`,
    [d.id, b.name !== undefined, b.name ?? null, b.location !== undefined, b.location ?? null, b.hwModel ?? null, b.isDisabled ?? null],
  );
  if (b.isDisabled === true && !d.is_disabled) {
    // drop the live state; Mosquitto refuses its next login
    await db.query(`UPDATE device_state SET is_online = false, offline_since = now() WHERE device_id = $1`, [d.id]);
  }
  live.invalidate(d.id);
  forgetMqttLogin(d.mqtt_username);
  await audit(req, 'device.update', 'device', d.id, b);
  res.json(await views.detail(d.id, 'admin'));
});

// 10.8 new claim code (old one stops working)
router.post('/:id/claim-code', async (req, res) => {
  const d = await loadDevice(req);
  const code = claimCode();
  await db.query('UPDATE devices SET claim_code_hash = $2 WHERE id = $1', [d.id, claimCodeHash(code)]);
  await audit(req, 'device.claim_code', 'device', d.id, { claimed: !!d.owner_id });
  const qr = qrPayload(d.serial_no, code);
  res.json({ claimCode: code, qrPayload: qr, qrPngBase64: await qrPngBase64(qr), note: d.owner_id ? 'Device is still owned; unclaim it before someone else can use this code.' : undefined });
});

// 10.9 MQTT secret: not used, devices log in by MAC only (decision 2026-11-01)
router.post('/:id/secret', async () => {
  throw E.notEnabled('Devices log in by MAC only; there is no device secret to rotate');
});

// 10.10 unclaim
router.post('/:id/unclaim', async (req, res) => {
  const d = await loadDevice(req);
  const b = parse(z.object({ reason: z.string().trim().min(1).max(200) }), req.body);
  if (!d.owner_id) throw E.conflict('NOT_CLAIMED', 'This device has no owner');
  await releaseDevice(d.id, b.reason, 'support');
  await audit(req, 'device.unclaim', 'device', d.id, { reason: b.reason, ownerId: d.owner_id });
  res.status(204).end();
});

// 10.11 transfer to another phone
router.post('/:id/transfer', async (req, res) => {
  const d = await loadDevice(req);
  const b = parse(z.object({ toPhone: z.string() }), req.body);
  const phone = normalizePhone(b.toPhone, 'toPhone');
  const to = await db.one('SELECT * FROM users WHERE phone = $1 AND deleted_at IS NULL', [phone]);
  if (!to) throw E.notFound('USER_NOT_FOUND', 'No account with this phone number', 'toPhone');
  if (to.is_blocked) throw E.conflict('USER_BLOCKED', 'That account is blocked', 'toPhone');
  if (to.id === d.owner_id) throw E.conflict('ALREADY_OWNER', 'This person already owns the device', 'toPhone');
  const oldOwner = d.owner_id;
  await db.tx(async (c) => {
    await c.query('DELETE FROM device_shares WHERE device_id = $1 AND user_id = $2', [d.id, to.id]);
    await c.query(`UPDATE devices SET owner_id = $2, claimed_at = COALESCE(claimed_at, now()), claim_code_hash = NULL WHERE id = $1`, [d.id, to.id]);
    await events.add(d.id, 'claimed', { message: `Transferred to ${to.full_name} by support`, data: { from: oldOwner, to: to.id } }, c);
    await audit(req, 'device.transfer', 'device', d.id, { from: oldOwner, to: to.id }, c);
  });
  live.invalidate(d.id);
  if (oldOwner) realtime.removeFromDevice(oldOwner, d.id);
  realtime.accessChanged(to.id, d.id, 'owner');
  res.json(await views.detail(d.id, 'admin'));
});

// 10.12 replace a board (repair). The MQTT username stays the same.
router.post('/:id/boards', async (req, res) => {
  const d = await loadDevice(req);
  const b = parse(z.object({ role: z.enum(['main', 'sender']), mac: z.string() }), req.body);
  const mac = normalizeMac(b.mac);
  await db.tx(async (c) => {
    const dup = await c.one('SELECT d.serial_no FROM device_boards b JOIN devices d ON d.id = b.device_id WHERE b.mac = $1', [mac]);
    if (dup) throw E.conflict('MAC_EXISTS', `This MAC is already registered to ${dup.serial_no}`, 'mac');
    const old = await c.one(`UPDATE device_boards SET replaced_at = now() WHERE device_id = $1 AND role = $2 AND replaced_at IS NULL RETURNING mac`, [d.id, b.role]);
    await c.query('INSERT INTO device_boards (device_id, role, mac) VALUES ($1,$2,$3)', [d.id, b.role, mac]);
    await audit(req, 'device.board_replace', 'device', d.id, { role: b.role, oldMac: old && macOut(old.mac), newMac: mac }, c);
  });
  res.status(201).json(await views.detail(d.id, 'admin'));
});

// 10.13 send a command
router.post('/:id/commands', async (req, res) => {
  const d = await loadDevice(req);
  const b = parse(z.object({ type: z.enum(['pump_on', 'pump_off', 'reboot', 'config_mode', 'ota_check', 'apply_settings']) }), req.body);
  const st = await live.stateFor(d.id);
  if (!st || !st.is_online) throw E.conflict('DEVICE_OFFLINE', 'The device is offline');
  if (b.type === 'apply_settings') await settingsSync.publish(d.id);
  const c = await commands.send(d, b.type, { source: 'admin', userId: req.user.id });
  await audit(req, 'device.command', 'device', d.id, { type: b.type, commandId: c.id });
  res.status(202).json({ commandId: c.id, status: c.status });
});

// 10.14 settings for support
router.patch('/:id/settings', async (req, res) => {
  const d = await loadDevice(req);
  const r = await settingsService.update(d.id, req.body, req.user.id);
  await audit(req, 'device.settings', 'device', d.id, req.body);
  res.json(r);
});

// 10.15 delete (only if never claimed, e.g. a mistyped MAC)
router.delete('/:id', async (req, res) => {
  const d = await loadDevice(req);
  const wasClaimed = d.owner_id || (await db.one(`SELECT 1 FROM device_events WHERE device_id = $1 AND type = 'claimed' LIMIT 1`, [d.id]));
  if (wasClaimed) throw E.conflict('DEVICE_WAS_CLAIMED', 'Only devices that were never claimed can be deleted');
  await db.query('DELETE FROM devices WHERE id = $1', [d.id]);
  live.invalidate(d.id);
  forgetMqttLogin(d.mqtt_username);
  // clear the retained settings message
  await mqtt.publish(mqtt.deviceTopic(d.mqtt_username, 'settings/set'), '', { qos: 1, retain: true });
  await audit(req, 'device.delete', 'device', d.id, { serial: d.serial_no });
  res.status(204).end();
});

module.exports = router;
