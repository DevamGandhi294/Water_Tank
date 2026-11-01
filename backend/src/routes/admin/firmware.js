// 10.22 - 10.30 admin: firmware releases and OTA rollouts
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../../config');
const db = require('../../db');
const { E } = require('../../errors');
const { z, parse } = require('../../lib/validate');
const { iso, compareVersions } = require('../../lib/format');
const { audit } = require('../../lib/audit');
const ota = require('../../services/ota');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

const fileNameFor = (board, version) => `${board === 'main' ? 'main_relay' : 'sender'}_${version}.bin`;

function release(r) {
  return {
    id: r.id, board: r.board, version: r.version, fileName: path.basename(r.file_path), fileSize: r.file_size,
    sha256: r.sha256, notes: r.notes, isStable: r.is_stable, uploadedBy: r.uploaded_by_name || null,
    createdAt: iso(r.created_at), devicesOnIt: r.devices_on_it ?? undefined,
  };
}

router.get('/firmware', async (_req, res) => {
  const rows = await db.many(
    `SELECT f.*, u.full_name AS uploaded_by_name,
            (SELECT count(*) FROM device_boards b WHERE b.role = f.board AND b.replaced_at IS NULL AND b.fw_version = f.version)::int AS devices_on_it
       FROM firmware_releases f LEFT JOIN users u ON u.id = f.uploaded_by ORDER BY f.created_at DESC`,
  );
  res.json({ items: rows.map(release) });
});

router.post('/firmware', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return next(E.bad('FILE_TOO_BIG', 'Firmware must be at most 1 MB', 'file'));
    if (err) return next(E.bad('UPLOAD_FAILED', err.message, 'file'));
    next();
  });
}, async (req, res) => {
  const b = parse(z.object({
    version: z.string().trim().regex(/^\d+(\.\d+){0,3}$/, 'must look like 1.4'),
    board: z.enum(['main', 'sender']).default('main'),
    notes: z.string().max(2000).optional(),
  }), req.body);
  const f = req.file;
  if (!f || !f.buffer || !f.size) throw E.bad('FILE_REQUIRED', 'Upload the .bin file', 'file');
  if (!/\.bin$/i.test(f.originalname || '')) throw E.bad('NOT_A_BIN', 'Only .bin files', 'file');
  // ESP8266 images start with 0xE9
  if (f.buffer[0] !== 0xe9) throw E.bad('NOT_ESP_IMAGE', 'This does not look like an ESP8266 firmware image', 'file');
  if (await db.one('SELECT 1 FROM firmware_releases WHERE board = $1 AND version = $2', [b.board, b.version])) {
    throw E.conflict('VERSION_EXISTS', `Version ${b.version} already exists`, 'version');
  }
  fs.mkdirSync(config.otaDir, { recursive: true });
  const filePath = path.join(config.otaDir, fileNameFor(b.board, b.version));
  fs.writeFileSync(filePath, f.buffer);
  const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
  const r = await db.one(
    `INSERT INTO firmware_releases (board, version, file_path, file_size, sha256, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.board, b.version, filePath, f.size, sha256, b.notes || null, req.user.id],
  );
  await audit(req, 'firmware.upload', 'firmware', r.id, { board: b.board, version: b.version, sha256 });
  res.status(201).json(release(r));
});

async function loadRelease(id) {
  const n = parseInt(id, 10);
  const r = Number.isFinite(n) ? await db.one('SELECT * FROM firmware_releases WHERE id = $1', [n]) : null;
  if (!r) throw E.notFound('RELEASE_NOT_FOUND', 'Firmware release not found');
  return r;
}

router.patch('/firmware/:id', async (req, res) => {
  const r = await loadRelease(req.params.id);
  const b = parse(z.object({ isStable: z.boolean().optional(), notes: z.union([z.string().max(2000), z.null()]).optional() }), req.body);
  const out = await db.tx(async (c) => {
    if (b.isStable === true) await c.query('UPDATE firmware_releases SET is_stable = false WHERE board = $1 AND is_stable', [r.board]);
    return c.one(
      `UPDATE firmware_releases SET is_stable = COALESCE($2, is_stable), notes = CASE WHEN $3::boolean THEN $4 ELSE notes END
        WHERE id = $1 RETURNING *`,
      [r.id, b.isStable ?? null, b.notes !== undefined, b.notes ?? null],
    );
  });
  await audit(req, 'firmware.update', 'firmware', r.id, b);
  res.json(release(out));
});

router.delete('/firmware/:id', async (req, res) => {
  const r = await loadRelease(req.params.id);
  if (await db.one('SELECT 1 FROM ota_rollouts WHERE release_id = $1 LIMIT 1', [r.id])) {
    throw E.conflict('RELEASE_IN_USE', 'This release was used in a rollout and cannot be deleted');
  }
  await db.query('DELETE FROM firmware_releases WHERE id = $1', [r.id]);
  fs.rmSync(r.file_path, { force: true });
  await audit(req, 'firmware.delete', 'firmware', r.id, { version: r.version });
  res.status(204).end();
});

// ---- rollouts
router.post('/ota/rollouts', async (req, res) => {
  const b = parse(z.object({
    releaseId: z.number().int(),
    targetAll: z.boolean().optional(),
    deviceIds: z.array(z.string().regex(/^[0-9a-f-]{36}$/i)).max(10000).optional(),
    filter: z.object({ fwBelow: z.string().regex(/^\d+(\.\d+){0,3}$/) }).optional(),
    notes: z.string().max(500).optional(),
  }), req.body);
  const r = await loadRelease(b.releaseId);
  if (!b.targetAll && !b.deviceIds && !b.filter) throw E.bad('NO_TARGET', 'Choose devices, a version filter or all devices');
  let devices = await db.many(
    `SELECT d.id, bm.fw_version FROM devices d
       LEFT JOIN device_boards bm ON bm.device_id = d.id AND bm.role = $1 AND bm.replaced_at IS NULL
      WHERE NOT d.is_disabled AND ($2::uuid[] IS NULL OR d.id = ANY($2))`,
    [r.board, b.deviceIds && !b.targetAll ? b.deviceIds : null],
  );
  if (b.filter && b.filter.fwBelow) devices = devices.filter((d) => !d.fw_version || compareVersions(d.fw_version, b.filter.fwBelow) < 0);
  if (!devices.length) throw E.invalid('NO_DEVICES', 'No devices match');
  const rollout = await db.tx(async (c) => {
    const o = await c.one(
      'INSERT INTO ota_rollouts (release_id, target_all, created_by, notes) VALUES ($1,$2,$3,$4) RETURNING *',
      [r.id, !!b.targetAll, req.user.id, b.notes || null],
    );
    for (const d of devices) {
      const same = d.fw_version && compareVersions(d.fw_version, r.version) === 0;
      await c.query(
        `INSERT INTO ota_rollout_devices (rollout_id, device_id, status, from_version, error) VALUES ($1,$2,$3,$4,$5)`,
        [o.id, d.id, same ? 'skipped' : 'pending', d.fw_version || null, same ? 'already on this version' : null],
      );
    }
    await audit(req, 'ota.push', 'rollout', o.id, { releaseId: r.id, version: r.version, devices: devices.length }, c);
    return o;
  });
  const sent = await ota.sendPendingForRollout(rollout.id);
  res.status(201).json({ rolloutId: rollout.id, devices: devices.length, sentNow: sent });
});

const COUNTS = `SELECT rollout_id, count(*)::int AS total,
    count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'sent')::int AS sent,
    count(*) FILTER (WHERE status = 'downloading')::int AS downloading, count(*) FILTER (WHERE status = 'success')::int AS success,
    count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'skipped')::int AS skipped
  FROM ota_rollout_devices`;

const rolloutOut = (o) => ({
  id: o.id, releaseId: o.release_id, version: o.version, board: o.board, targetAll: o.target_all, notes: o.notes,
  createdBy: o.created_by_name || null, createdAt: iso(o.created_at), cancelledAt: iso(o.cancelled_at),
  counts: { total: o.total || 0, pending: o.pending || 0, sent: o.sent || 0, downloading: o.downloading || 0, success: o.success || 0, failed: o.failed || 0, skipped: o.skipped || 0 },
});

router.get('/ota/rollouts', async (_req, res) => {
  const rows = await db.many(
    `SELECT o.*, f.version, f.board, u.full_name AS created_by_name, c.* , o.id AS id
       FROM ota_rollouts o JOIN firmware_releases f ON f.id = o.release_id LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN (${COUNTS} GROUP BY rollout_id) c ON c.rollout_id = o.id
      ORDER BY o.created_at DESC LIMIT 100`,
  );
  res.json({ items: rows.map(rolloutOut) });
});

async function loadRollout(id) {
  const n = parseInt(id, 10);
  const o = Number.isFinite(n) ? await db.one(
    `SELECT o.*, f.version, f.board, u.full_name AS created_by_name, c.*, o.id AS id
       FROM ota_rollouts o JOIN firmware_releases f ON f.id = o.release_id LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN (${COUNTS} WHERE rollout_id = $1 GROUP BY rollout_id) c ON c.rollout_id = o.id WHERE o.id = $1`, [n]) : null;
  if (!o) throw E.notFound('ROLLOUT_NOT_FOUND', 'Rollout not found');
  return o;
}

router.get('/ota/rollouts/:id', async (req, res) => {
  const o = await loadRollout(req.params.id);
  const devices = await db.many(
    `SELECT od.*, d.serial_no, d.name FROM ota_rollout_devices od JOIN devices d ON d.id = od.device_id
      WHERE od.rollout_id = $1 ORDER BY d.serial_no`, [o.id]);
  res.json({
    rollout: rolloutOut(o),
    devices: devices.map((d) => ({ deviceId: d.device_id, serial: d.serial_no, name: d.name, status: d.status, fromVersion: d.from_version, error: d.error, updatedAt: iso(d.updated_at) })),
  });
});

router.post('/ota/rollouts/:id/cancel', async (req, res) => {
  const o = await loadRollout(req.params.id);
  if (o.cancelled_at) return res.status(204).end();
  await db.query('UPDATE ota_rollouts SET cancelled_at = now() WHERE id = $1', [o.id]);
  await db.query(`UPDATE ota_rollout_devices SET status = 'skipped', error = 'cancelled', updated_at = now() WHERE rollout_id = $1 AND status = 'pending'`, [o.id]);
  await audit(req, 'ota.cancel', 'rollout', o.id);
  res.status(204).end();
});

router.post('/ota/rollouts/:id/retry', async (req, res) => {
  const o = await loadRollout(req.params.id);
  if (o.cancelled_at) throw E.conflict('ROLLOUT_CANCELLED', 'This rollout was cancelled');
  const r = await db.query(`UPDATE ota_rollout_devices SET status = 'pending', error = NULL, updated_at = now() WHERE rollout_id = $1 AND status = 'failed'`, [o.id]);
  const sent = await ota.sendPendingForRollout(o.id);
  await audit(req, 'ota.retry', 'rollout', o.id, { devices: r.rowCount });
  res.json({ retried: r.rowCount, sentNow: sent });
});

module.exports = router;
