// Alerts: decide who gets told about what, write notifications, push via FCM.
const { DateTime } = require('luxon');
const db = require('../db');
const logger = require('../logger');
const realtime = require('./realtime');
const push = require('./push');
const { iso } = require('../lib/format');

const TYPES = ['tank_full', 'tank_low', 'sensor_fault', 'device_offline', 'pump_long_run', 'ota_result'];
const COOLDOWN_MIN = { tank_full: 30, tank_low: 30, sensor_fault: 15, pump_long_run: 60, device_offline: 0, ota_result: 0 };

// defaults when a user has no alert_settings row
function defaultThreshold(type, settings) {
  switch (type) {
    case 'tank_full': return settings ? settings.full_level_pct : 95;
    case 'tank_low': return settings ? settings.low_level_pct : 20;
    case 'device_offline': return 30;
    case 'pump_long_run': return (settings && settings.max_pump_minutes) || 60;
    default: return null;
  }
}

// Everyone with access + their setting for this type (no row = enabled, default threshold)
async function recipients(deviceId, type) {
  return db.many(
    `SELECT da.user_id, a.is_enabled, a.threshold, a.quiet_from, a.quiet_to
       FROM device_access da
       JOIN users u ON u.id = da.user_id AND u.deleted_at IS NULL AND NOT u.is_blocked
       LEFT JOIN alert_settings a ON a.user_id = da.user_id AND a.device_id = da.device_id AND a.type = $2
      WHERE da.device_id = $1`,
    [deviceId, type],
  );
}

function inQuietHours(r, timezone) {
  if (!r.quiet_from || !r.quiet_to) return false;
  const now = DateTime.now().setZone(timezone || 'Asia/Kolkata').toFormat('HH:mm:ss');
  const from = r.quiet_from;
  const to = r.quiet_to;
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

// Write + push one notification for one user (cooldown already checked by caller or here)
async function deliver(userId, deviceId, type, { title, body, eventId }, { timezone, quiet, cooldown = true } = {}) {
  const mins = COOLDOWN_MIN[type] || 0;
  if (cooldown && mins > 0) {
    const recent = await db.one(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND device_id = $2 AND type = $3
          AND created_at > now() - make_interval(mins => $4) LIMIT 1`,
      [userId, deviceId, type, mins],
    );
    if (recent) return null;
  }
  const n = await db.one(
    `INSERT INTO notifications (user_id, device_id, type, title, body, event_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, deviceId, type, title, body, eventId || null],
  );
  const device = deviceId ? await db.one('SELECT name, serial_no FROM devices WHERE id = $1', [deviceId]) : null;
  realtime.toUser(userId, 'notification', { notification: serialize({ ...n, device_name: device && (device.name || device.serial_no) }) });
  if (!quiet) {
    const r = await push.sendToUser(userId, { title, body, data: { type, deviceId: deviceId || '', notificationId: n.id } });
    await db.query('UPDATE notifications SET push_sent = $2, push_error = $3 WHERE id = $1', [n.id, r.sent, r.error || null]);
  }
  return n;
}

// Tell everyone with access who has this alert on. filter(r, threshold) may drop users.
async function notify(deviceId, type, content, filter) {
  try {
    const dev = await db.one(
      `SELECT d.timezone, s.* FROM devices d LEFT JOIN device_settings s ON s.device_id = d.id WHERE d.id = $1`,
      [deviceId],
    );
    if (!dev) return;
    const list = await recipients(deviceId, type);
    for (const r of list) {
      if (r.is_enabled === false) continue;
      const threshold = r.threshold ?? defaultThreshold(type, dev);
      if (filter && !filter(r, threshold)) continue;
      const c = typeof content === 'function' ? content(threshold) : content;
      await deliver(r.user_id, deviceId, type, c, { timezone: dev.timezone, quiet: inQuietHours(r, dev.timezone) });
    }
  } catch (err) {
    logger.error({ err, deviceId, type }, 'notify failed');
  }
}

// Level crossed a user's full / low threshold
async function checkLevel(deviceId, name, prevPct, newPct) {
  if (prevPct == null || newPct == null || prevPct === newPct) return;
  if (newPct > prevPct) {
    await notify(deviceId, 'tank_full', (t) => ({ title: `${name} is full`, body: `Water level is ${newPct}%.` }),
      (_r, t) => t != null && prevPct < t && newPct >= t);
  } else {
    await notify(deviceId, 'tank_low', (t) => ({ title: `${name} is low`, body: `Level is ${newPct}%, below your ${t}% alert.` }),
      (_r, t) => t != null && prevPct > t && newPct <= t);
  }
}

function serialize(n) {
  return {
    id: n.id, deviceId: n.device_id, deviceName: n.device_name || null, type: n.type,
    title: n.title, body: n.body, createdAt: iso(n.created_at), readAt: iso(n.read_at),
  };
}

module.exports = { TYPES, defaultThreshold, notify, deliver, checkLevel, serialize, inQuietHours };
