// OTA rollouts: publish wt/<d>/ota with a signed download URL, track wt/<d>/ota/status.
const config = require('../config');
const db = require('../db');
const mqtt = require('./mqtt');
const realtime = require('./realtime');
const events = require('./events');
const alerts = require('./alerts');
const { signPurpose } = require('./tokens');

function downloadUrl(releaseId, deviceId, rolloutId) {
  const t = signPurpose('fw', { fid: releaseId, d: deviceId, rid: rolloutId }, config.otaTokenTtlS);
  return `${config.publicBaseUrl}/fw/${releaseId}.bin?t=${encodeURIComponent(t)}`;
}

async function setStatus(rolloutId, deviceId, status, error = null) {
  const row = await db.one(
    `UPDATE ota_rollout_devices SET status = $3, error = $4, updated_at = now()
      WHERE rollout_id = $1 AND device_id = $2 RETURNING *`,
    [rolloutId, deviceId, status, error],
  );
  if (row) realtime.toAdmin('ota:progress', { rolloutId, deviceId, status, error });
  return row;
}

// Send one device its OTA message (only if it is online and the rollout is still active)
async function sendToDevice(rolloutId, deviceId) {
  const r = await db.one(
    `SELECT o.id AS rollout_id, o.cancelled_at, f.id AS release_id, f.version, f.sha256, f.file_size,
            d.mqtt_username, COALESCE(s.is_online, false) AS online, d.is_disabled
       FROM ota_rollouts o JOIN firmware_releases f ON f.id = o.release_id
       JOIN ota_rollout_devices od ON od.rollout_id = o.id AND od.device_id = $2
       JOIN devices d ON d.id = od.device_id
       LEFT JOIN device_state s ON s.device_id = d.id
      WHERE o.id = $1`,
    [rolloutId, deviceId],
  );
  if (!r || r.cancelled_at || !r.online || r.is_disabled) return false;
  const ok = await mqtt.publish(mqtt.deviceTopic(r.mqtt_username, 'ota'), {
    rid: r.rollout_id,
    ver: r.version,
    url: downloadUrl(r.release_id, deviceId, r.rollout_id),
    sha256: r.sha256,
    size: r.file_size,
  }, { qos: 1 });
  if (ok) await setStatus(rolloutId, deviceId, 'sent');
  return ok;
}

// device came online: send anything still pending for it
async function sendPendingFor(deviceId) {
  const rows = await db.many(
    `SELECT od.rollout_id FROM ota_rollout_devices od JOIN ota_rollouts o ON o.id = od.rollout_id
      WHERE od.device_id = $1 AND od.status = 'pending' AND o.cancelled_at IS NULL
      ORDER BY o.created_at DESC LIMIT 1`,
    [deviceId],
  );
  for (const r of rows) await sendToDevice(r.rollout_id, deviceId);
}

async function sendPendingForRollout(rolloutId) {
  const rows = await db.many(
    `SELECT od.device_id FROM ota_rollout_devices od JOIN device_state s ON s.device_id = od.device_id
      WHERE od.rollout_id = $1 AND od.status = 'pending' AND s.is_online`,
    [rolloutId],
  );
  let n = 0;
  for (const r of rows) if (await sendToDevice(rolloutId, r.device_id)) n++;
  return n;
}

async function finished(rolloutId, deviceId, ok, error, version) {
  const row = await setStatus(rolloutId, deviceId, ok ? 'success' : 'failed', ok ? null : error || 'failed');
  if (!row) return;
  const dev = await db.one('SELECT name, serial_no FROM devices WHERE id = $1', [deviceId]);
  const name = (dev && (dev.name || dev.serial_no)) || 'Tank';
  const e = await events.add(deviceId, ok ? 'ota_success' : 'ota_failed', {
    severity: ok ? 'info' : 'warning',
    message: ok ? `Firmware ${version || ''} installed`.trim() : `Firmware update failed: ${error || 'unknown error'}`,
    data: { rolloutId, version, error },
    oneOff: true,
  });
  await alerts.notify(deviceId, 'ota_result', {
    title: ok ? `${name} updated` : `${name} update failed`,
    body: ok ? `Firmware ${version || ''} is installed.`.trim() : `The firmware update failed (${error || 'unknown'}).`,
    eventId: e.id,
  });
}

// {"rid":3,"s":"downloading"} | {"rid":3,"s":"success"} | {"rid":3,"s":"failed","err":"..."}
async function handleStatus(deviceId, p) {
  const rid = parseInt(p && p.rid, 10);
  if (!Number.isFinite(rid)) return;
  const s = String(p.s || '').toLowerCase();
  const rel = await db.one(
    `SELECT f.version FROM ota_rollouts o JOIN firmware_releases f ON f.id = o.release_id WHERE o.id = $1`, [rid]);
  if (s === 'downloading') {
    const row = await setStatus(rid, deviceId, 'downloading');
    if (row) await events.add(deviceId, 'ota_started', { message: `Installing firmware ${rel ? rel.version : ''}`.trim(), data: { rolloutId: rid } });
  } else if (s === 'success') {
    await finished(rid, deviceId, true, null, rel && rel.version);
  } else if (s === 'failed') {
    await finished(rid, deviceId, false, String(p.err || 'failed').slice(0, 200), rel && rel.version);
  }
}

// the board reported a new fw in its state: close any rollout waiting for that version
async function checkFirmware(deviceId, fw) {
  const rows = await db.many(
    `SELECT od.rollout_id, f.version FROM ota_rollout_devices od
       JOIN ota_rollouts o ON o.id = od.rollout_id JOIN firmware_releases f ON f.id = o.release_id
      WHERE od.device_id = $1 AND od.status IN ('sent', 'downloading') AND f.version = $2`,
    [deviceId, fw],
  );
  for (const r of rows) await finished(r.rollout_id, deviceId, true, null, r.version);
}

module.exports = { sendToDevice, sendPendingFor, sendPendingForRollout, handleStatus, checkFirmware, setStatus, downloadUrl };
