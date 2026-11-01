// device_events helper: write, resolve, push to sockets.
const db = require('../db');
const realtime = require('./realtime');
const { event: ser } = require('../lib/serialize');

// oneOff: a warning that is over as soon as it happens (e.g. ON refused), so it never shows as an open fault
async function add(deviceId, type, { severity = 'info', message = null, data = null, oneOff = false } = {}, client = db) {
  const e = await client.one(
    `INSERT INTO device_events (device_id, type, severity, message, data, resolved_at)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $6 THEN now() END) RETURNING *`,
    [deviceId, type, severity, message, data ? JSON.stringify(data) : null, oneOff],
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
