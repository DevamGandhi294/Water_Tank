// OTA for the SENDER board. The sender has no MQTT (it talks to the main board by LoRa),
// so it asks for its update itself over HTTPS, at boot and every few hours:
//   GET  /ota/sender?mac=<sender MAC>&fw=<running version>
//        200 {"rid":3,"ver":"5.1","url":"https://.../fw/7.bin?t=...","sha256":"...","size":1234567}
//        204 nothing to install
//   POST /ota/sender/status {"mac":"..","rid":3,"s":"downloading"|"failed","err":".."}
// "success" is not posted: after the reboot the next check reports the new fw.
// The board is known by the sender MAC registered in the admin panel (the same MAC-only
// trust as the main board's MQTT login).
const express = require('express');
const db = require('../db');
const { E } = require('../errors');
const { normalizeMac, compareVersions } = require('../lib/format');
const { limiter } = require('../middleware/rateLimit');
const ota = require('../services/ota');

const router = express.Router();
const VERSION = /^\d+(\.\d+){0,3}$/;
const perMac = limiter('sender-ota', {
  limit: 30,
  windowMs: 10 * 60_000,
  keyFn: (req) => String((req.query && req.query.mac) || (req.body && req.body.mac) || ''),
});

async function senderBoard(mac) {
  const m = normalizeMac(mac);
  const b = await db.one(
    `SELECT b.id, b.device_id, b.fw_version FROM device_boards b JOIN devices d ON d.id = b.device_id
      WHERE b.mac = $1::macaddr AND b.role = 'sender' AND b.replaced_at IS NULL AND NOT d.is_disabled`,
    [m],
  );
  if (!b) throw E.notFound('UNKNOWN_SENDER', 'This sender is not registered');
  return b;
}

router.get('/ota/sender', perMac, async (req, res) => {
  const b = await senderBoard(req.query.mac);
  const fw = VERSION.test(String(req.query.fw || '')) ? String(req.query.fw) : null;
  if (fw && fw !== b.fw_version) await db.query('UPDATE device_boards SET fw_version = $2 WHERE id = $1', [b.id, fw]);
  if (fw) await ota.checkFirmware(b.device_id, fw, 'sender'); // a rollout to this version is done
  res.set('Cache-Control', 'no-store');

  const job = await db.one(
    `SELECT o.id AS rollout_id, od.status, f.id AS release_id, f.version, f.sha256, f.file_size
       FROM ota_rollout_devices od JOIN ota_rollouts o ON o.id = od.rollout_id
       JOIN firmware_releases f ON f.id = o.release_id
      WHERE od.device_id = $1 AND f.board = 'sender' AND o.cancelled_at IS NULL
        AND od.status IN ('pending', 'sent', 'downloading')
      ORDER BY o.created_at DESC LIMIT 1`,
    [b.device_id],
  );
  if (!job) return res.status(204).end();
  if (fw && compareVersions(job.version, fw) <= 0) {
    await ota.setStatus(job.rollout_id, b.device_id, 'skipped', `already on ${fw}`);
    return res.status(204).end();
  }
  if (job.status === 'pending') await ota.setStatus(job.rollout_id, b.device_id, 'sent');
  res.json({
    rid: job.rollout_id,
    ver: job.version,
    url: ota.downloadUrl(job.release_id, b.device_id, job.rollout_id),
    sha256: job.sha256,
    size: job.file_size,
  });
});

router.post('/ota/sender/status', express.json({ limit: '2kb' }), perMac, async (req, res) => {
  const p = req.body || {};
  const b = await senderBoard(p.mac);
  const s = String(p.s || '').toLowerCase();
  if (s !== 'downloading' && s !== 'failed') throw E.bad('BAD_STATUS', 's must be downloading or failed', 's');
  const rid = parseInt(p.rid, 10);
  const own = Number.isFinite(rid) && await db.one(
    `SELECT 1 FROM ota_rollout_devices od JOIN ota_rollouts o ON o.id = od.rollout_id
       JOIN firmware_releases f ON f.id = o.release_id
      WHERE od.rollout_id = $1 AND od.device_id = $2 AND f.board = 'sender'`,
    [rid, b.device_id],
  );
  if (!own) throw E.notFound('ROLLOUT_NOT_FOUND', 'No such update for this sender');
  await ota.handleStatus(b.device_id, { rid, s, err: p.err });
  res.status(204).end();
});

module.exports = router;
