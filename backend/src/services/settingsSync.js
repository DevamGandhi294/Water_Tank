// Settings sync with the ESP: backend bumps version (trigger), publishes retained
// wt/<d>/settings/set {"v":4,"cutoff_cm":35,"auto":1,"max_min":60}, the ESP saves it
// and answers wt/<d>/settings/ack {"v":4}.
const db = require('../db');
const mqtt = require('./mqtt');
const realtime = require('./realtime');
const events = require('./events');

function payloadFor(s) {
  return {
    v: s.version,
    cutoff_cm: s.cutoff_distance_cm,
    auto: s.auto_mode ? 1 : 0,
    max_min: s.max_pump_minutes || 0,
  };
}

function syncState(s, online) {
  if (s.version <= s.applied_version) return 'applied';
  return online ? 'sending' : 'queued_offline';
}

// Publish the current settings (retained). Returns the sync state.
async function publish(deviceId) {
  const s = await db.one(
    `SELECT s.*, d.mqtt_username, COALESCE(st.is_online, false) AS online
       FROM device_settings s JOIN devices d ON d.id = s.device_id
       LEFT JOIN device_state st ON st.device_id = s.device_id
      WHERE s.device_id = $1`,
    [deviceId],
  );
  if (!s) return null;
  const ok = await mqtt.publish(mqtt.deviceTopic(s.mqtt_username, 'settings/set'), payloadFor(s), { qos: 1, retain: true });
  if (ok) await db.query('UPDATE device_settings SET sent_at = now() WHERE device_id = $1', [deviceId]);
  const sync = syncState(s, s.online);
  realtime.toDevice(deviceId, 'settings:sync', { deviceId, version: s.version, appliedVersion: s.applied_version, sync });
  return sync;
}

async function ack(deviceId, p) {
  const v = parseInt(p && p.v, 10);
  if (!Number.isFinite(v)) return null;
  const s = await db.one(
    `UPDATE device_settings SET applied_version = $2, applied_at = now()
      WHERE device_id = $1 AND $2 <= version AND $2 > applied_version RETURNING *`,
    [deviceId, v],
  );
  if (!s) return null;
  await events.add(deviceId, 'settings_applied', { message: `Settings saved on device (v${v})`, data: { version: v } });
  realtime.toDevice(deviceId, 'settings:sync', {
    deviceId, version: s.version, appliedVersion: s.applied_version, sync: syncState(s, true),
  });
  return s;
}

module.exports = { publish, ack, payloadFor, syncState };
