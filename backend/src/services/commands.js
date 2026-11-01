// device_commands: write the row, publish wt/<d>/cmd, wait for wt/<d>/cmd/ack.
const config = require('../config');
const db = require('../db');
const mqtt = require('./mqtt');
const realtime = require('./realtime');
const pumpRuns = require('./pumpRuns');

const STOP_REASON = { app: 'app', timer: 'timer', admin: 'admin', system: 'max_runtime', auto: 'auto_cutoff', button: 'button' };

const result = (c) => ({ commandId: c.id, deviceId: c.device_id, type: c.type, status: c.status, error: c.error });

// opts: { source, userId, payload, stopReason }
async function send(device, type, opts) {
  const { source, userId = null, payload = null } = opts;
  const c = await db.one(
    `INSERT INTO device_commands (device_id, type, payload, source, requested_by, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6)) RETURNING *`,
    [device.id, type, payload ? JSON.stringify(payload) : null, source, userId, config.commandTtlS],
  );
  if (type === 'pump_on') {
    pumpRuns.setStartHint(device.id, { source, userId, timerId: payload && payload.timerId, commandId: c.id });
  } else if (type === 'pump_off') {
    pumpRuns.setStopHint(device.id, { reason: opts.stopReason || STOP_REASON[source] || 'app', userId, commandId: c.id });
  }
  const ok = await mqtt.publish(mqtt.deviceTopic(device.mqtt_username, 'cmd'), { id: c.id, c: type }, { qos: 1 });
  const upd = ok
    ? await db.one(`UPDATE device_commands SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING *`, [c.id])
    : await db.one(`UPDATE device_commands SET status = 'failed', error = 'broker_unavailable' WHERE id = $1 RETURNING *`, [c.id]);
  if (!ok) realtime.toDevice(device.id, 'command:result', result(upd));
  return upd;
}

// {"id":812,"ok":1} or {"id":812,"ok":0,"err":"near"}
async function ack(deviceId, p) {
  const id = parseInt(p && p.id, 10);
  if (!Number.isFinite(id)) return null;
  const ok = p.ok === 1 || p.ok === true || p.ok === '1';
  const c = await db.one(
    `UPDATE device_commands SET status = $3, error = $4, acked_at = now()
      WHERE id = $1 AND device_id = $2 AND status IN ('pending', 'sent') RETURNING *`,
    [id, deviceId, ok ? 'acked' : 'failed', ok ? null : String(p.err || 'refused').slice(0, 100)],
  );
  if (!c) return null;
  if (!ok && c.type === 'pump_on') pumpRuns.clearStartHint(deviceId);
  realtime.toDevice(deviceId, 'command:result', result(c));
  return c;
}

async function expireDue() {
  const rows = await db.many(
    `UPDATE device_commands SET status = 'expired', error = COALESCE(error, 'no_ack')
      WHERE status IN ('pending', 'sent') AND expires_at < now() RETURNING *`,
  );
  rows.forEach((c) => realtime.toDevice(c.device_id, 'command:result', result(c)));
  return rows.length;
}

async function failOpenFor(deviceId, error) {
  const rows = await db.many(
    `UPDATE device_commands SET status = 'failed', error = $2
      WHERE device_id = $1 AND status IN ('pending', 'sent') RETURNING *`,
    [deviceId, error],
  );
  rows.forEach((c) => realtime.toDevice(deviceId, 'command:result', result(c)));
}

module.exports = { send, ack, expireDue, failOpenFor, result };
