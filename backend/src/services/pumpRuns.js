// pump_runs: one row per ON -> OFF cycle. The ESP reports the relay state; the backend
// remembers who asked for the change (app / timer / admin / button) for a short time
// so the run gets the right source and stop reason.
const db = require('../db');
const realtime = require('./realtime');
const { iso } = require('../lib/format');

const HINT_MS = 60_000;
const hints = new Map(); // deviceId -> { start: {...,at}, stop: {...,at} }

function setStartHint(deviceId, h) {
  const x = hints.get(deviceId) || {};
  x.start = { ...h, at: Date.now() };
  hints.set(deviceId, x);
}
function setStopHint(deviceId, h) {
  const x = hints.get(deviceId) || {};
  x.stop = { ...h, at: Date.now() };
  hints.set(deviceId, x);
}
function take(deviceId, kind) {
  const x = hints.get(deviceId);
  const h = x && x[kind];
  if (!h) return null;
  delete x[kind];
  return Date.now() - h.at <= HINT_MS ? h : null;
}
function clearStartHint(deviceId) {
  const x = hints.get(deviceId);
  if (x) delete x.start;
}

const SELECT_RUN = `
  SELECT r.*, su.full_name AS started_by_name, pu.full_name AS stopped_by_name, t.name AS timer_name
    FROM pump_runs r
    LEFT JOIN users su ON su.id = r.started_by
    LEFT JOIN users pu ON pu.id = r.stopped_by
    LEFT JOIN timers t ON t.id = r.timer_id`;

function serialize(r) {
  if (!r) return null;
  return {
    id: r.id,
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
    durationS: r.duration_s,
    startSource: r.start_source,
    startedBy: r.started_by_name || null,
    stopReason: r.stop_reason,
    stoppedBy: r.stopped_by_name || null,
    startLevelPct: r.start_level_pct,
    endLevelPct: r.end_level_pct,
    startDistanceCm: r.start_distance_cm,
    endDistanceCm: r.end_distance_cm,
    timerName: r.timer_name || null,
  };
}

async function byId(id) {
  return db.one(`${SELECT_RUN} WHERE r.id = $1`, [id]);
}

// state = { distance_cm, level_pct }
async function opened(deviceId, state, srcFromDevice) {
  const h = take(deviceId, 'start');
  let source = 'button';
  let userId = null;
  let timerId = null;
  if (h) { source = h.source; userId = h.userId || null; timerId = h.timerId || null; }
  else if (srcFromDevice) source = srcFromDevice;
  const row = await db.one(
    `INSERT INTO pump_runs (device_id, started_at, start_source, started_by, start_distance_cm, start_level_pct, timer_id)
     VALUES ($1, now(), $2, $3, $4, $5, $6)
     ON CONFLICT (device_id) WHERE ended_at IS NULL DO NOTHING
     RETURNING id`,
    [deviceId, source, userId, state.distance_cm, state.level_pct, timerId],
  );
  if (!row) return null;
  const run = serialize(await byId(row.id));
  realtime.toDevice(deviceId, 'pump:run', { deviceId, run });
  return run;
}

async function closed(deviceId, state, reasonFromDevice) {
  const h = take(deviceId, 'stop');
  let reason = 'unknown';
  let userId = null;
  if (h) { reason = h.reason; userId = h.userId || null; }
  else if (reasonFromDevice) reason = reasonFromDevice;
  const row = await db.one(
    `UPDATE pump_runs SET ended_at = now(), stop_reason = $2, stopped_by = $3,
            end_distance_cm = $4, end_level_pct = $5
      WHERE device_id = $1 AND ended_at IS NULL RETURNING id`,
    [deviceId, reason, userId, state.distance_cm, state.level_pct],
  );
  if (!row) return null;
  const run = serialize(await byId(row.id));
  realtime.toDevice(deviceId, 'pump:run', { deviceId, run });
  return run;
}

async function openRun(deviceId) {
  return serialize(await db.one(`${SELECT_RUN} WHERE r.device_id = $1 AND r.ended_at IS NULL`, [deviceId]));
}

module.exports = { setStartHint, setStopHint, clearStartHint, opened, closed, openRun, serialize, SELECT_RUN };
