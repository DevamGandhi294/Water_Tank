// device_events helper: write, resolve, push to sockets.
const db = require('../db');
const realtime = require('./realtime');
const { event: ser } = require('../lib/serialize');

async function add(deviceId, type, { severity = 'info', message = null, data = null } = {}, client = db) {
  const e = await client.one(
    `INSERT INTO device_events (device_id, type, severity, message, data) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [deviceId, type, severity, message, data ? JSON.stringify(data) : null],
  );
  realtime.toDevice(deviceId, 'device:event', { deviceId, event: ser(e) });
  return e;
}

// mark open warning/critical events of these types as cleared
async function resolve(deviceId, types) {
  const rows = await db.many(
    `UPDATE device_events SET resolved_at = now()
      WHERE device_id = $1 AND type = ANY($2::event_type[]) AND severity <> 'info' AND resolved_at IS NULL
      RETURNING *`,
    [deviceId, types],
  );
  rows.forEach((e) => realtime.toDevice(deviceId, 'device:event', { deviceId, event: ser(e) }));
  return rows;
}

module.exports = { add, resolve };
