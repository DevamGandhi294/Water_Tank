// Background jobs (one backend instance):
//  every minute  timers (start / stop), offline alerts
//  every 5 s     command expiry
//  every 15 s    stale devices (no message, LWT lost)
//  every 30 s    max pump run time + long run alert
//  every 10 s    admin:stats to the admin room when it changed
//  nightly       retention cleanup
const { DateTime } = require('luxon');
const db = require('../db');
const logger = require('../logger');
const live = require('./live');
const commands = require('./commands');
const alerts = require('./alerts');
const realtime = require('./realtime');
const { dayOn, hhmm } = require('../lib/timers');

const timersHandles = [];
const every = (ms, name, fn) => {
  let running = false;
  const h = setInterval(async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (err) { logger.error({ err, job: name }, 'job failed'); } finally { running = false; }
  }, ms);
  timersHandles.push(h);
};

async function skip(t, reason) {
  await db.query('UPDATE timers SET last_skipped_at = now(), last_skip_reason = $2 WHERE id = $1', [t.id, reason]);
  logger.info({ timer: t.id, reason }, 'timer start skipped');
}

// Runs once per minute. Each device time zone is handled separately so the
// start_time / stop_time indexes are used.
async function runTimers(now = DateTime.now()) {
  const zones = await db.many(`SELECT DISTINCT d.timezone FROM timers t JOIN devices d ON d.id = t.device_id WHERE t.is_enabled`);
  for (const { timezone } of zones) {
    const local = now.setZone(timezone);
    if (!local.isValid) continue;
    const hm = local.toFormat('HH:mm');
    const due = await db.many(
      `SELECT t.*, d.mqtt_username, d.is_disabled, d.owner_id FROM timers t JOIN devices d ON d.id = t.device_id
        WHERE t.is_enabled AND d.timezone = $1 AND (t.start_time = $2::time OR t.stop_time = $2::time)`,
      [timezone, hm],
    );
    for (const t of due) {
      const device = { id: t.device_id, mqtt_username: t.mqtt_username };
      const isStart = hhmm(t.start_time) === hm;
      const isStop = hhmm(t.stop_time) === hm;
      // a stop time earlier than the start belongs to the run that began the day before
      const startDayOk = dayOn(t.days_mask, local.weekday);
      const stopDay = hhmm(t.stop_time) < hhmm(t.start_time) ? local.minus({ days: 1 }).weekday : local.weekday;
      const stopDayOk = dayOn(t.days_mask, stopDay);
      try {
        if (isStop && stopDayOk) await timerStop(t, device);
        if (isStart && startDayOk) await timerStart(t, device);
      } catch (err) {
        logger.error({ err, timer: t.id }, 'timer failed');
      }
    }
  }
}

async function timerStart(t, device) {
  if (t.is_disabled || !t.owner_id) return skip(t, 'device_disabled');
  const st = await live.stateFor(t.device_id);
  if (!st || !st.is_online) return skip(t, 'offline');
  if (st.pump_on) return skip(t, 'already_running');
  const s = await db.one('SELECT cutoff_distance_cm, auto_mode FROM device_settings WHERE device_id = $1', [t.device_id]);
  if (st.distance_cm !== null && st.distance_cm <= s.cutoff_distance_cm) return skip(t, 'tank_full');
  if (s.auto_mode && (st.status === 'FAULT' || st.status === 'DOWN')) return skip(t, 'sensor_fault');
  if (t.only_if_below_pct != null && st.level_pct != null && st.level_pct >= t.only_if_below_pct) {
    return skip(t, `level_${st.level_pct}`);
  }
  await commands.send(device, 'pump_on', { source: 'timer', payload: { timerId: t.id } });
  await db.query('UPDATE timers SET last_started_at = now() WHERE id = $1', [t.id]);
}

async function timerStop(t, device) {
  // only stop a run this timer started (not one a person switched on by hand)
  const run = await db.one('SELECT id FROM pump_runs WHERE device_id = $1 AND ended_at IS NULL AND timer_id = $2', [t.device_id, t.id]);
  const st = await live.stateFor(t.device_id);
  const startedRecently = t.last_started_at && (!t.last_stopped_at || t.last_stopped_at < t.last_started_at)
    && Date.now() - new Date(t.last_started_at).getTime() < 24 * 3600 * 1000;
  if (!run && !startedRecently) return;
  if (!st || !st.is_online || !st.pump_on) {
    await db.query('UPDATE timers SET last_stopped_at = now() WHERE id = $1', [t.id]);
    return;
  }
  await commands.send(device, 'pump_off', { source: 'timer' });
  await db.query('UPDATE timers SET last_stopped_at = now() WHERE id = $1', [t.id]);
}

// pump on longer than max_pump_minutes: switch it off; long-run alert per user threshold
async function checkLongRuns() {
  const rows = await db.many(
    `SELECT r.device_id, r.id AS run_id, r.started_at, s.max_pump_minutes, d.mqtt_username, COALESCE(d.name, d.serial_no) AS name,
            EXTRACT(EPOCH FROM (now() - r.started_at))::int AS secs
       FROM pump_runs r JOIN device_settings s ON s.device_id = r.device_id JOIN devices d ON d.id = r.device_id
      WHERE r.ended_at IS NULL`,
  );
  for (const r of rows) {
    const mins = Math.floor(r.secs / 60);
    if (r.max_pump_minutes && mins >= r.max_pump_minutes) {
      const open = await db.one(
        `SELECT 1 FROM device_commands WHERE device_id = $1 AND type = 'pump_off' AND source = 'system'
            AND created_at > now() - interval '2 minutes'`, [r.device_id]);
      const st = await live.stateFor(r.device_id);
      if (!open && st && st.is_online) {
        await commands.send({ id: r.device_id, mqtt_username: r.mqtt_username }, 'pump_off', { source: 'system', stopReason: 'max_runtime' });
      }
    }
    await alerts.notify(r.device_id, 'pump_long_run',
      (t) => ({ title: `${r.name}: pump running long`, body: `The pump has been on for ${mins} minutes (your alert is ${t} min).` }),
      (_u, t) => t != null && mins >= t);
  }
}

async function offlineAlerts() {
  const rows = await db.many(
    `SELECT ds.device_id, da.user_id, COALESCE(a.threshold, 30) AS th, COALESCE(d.name, d.serial_no) AS name,
            a.quiet_from, a.quiet_to, d.timezone, ds.offline_since
       FROM device_state ds
       JOIN devices d ON d.id = ds.device_id
       JOIN device_access da ON da.device_id = ds.device_id
       JOIN users u ON u.id = da.user_id AND u.deleted_at IS NULL AND NOT u.is_blocked
       LEFT JOIN alert_settings a ON a.user_id = da.user_id AND a.device_id = ds.device_id AND a.type = 'device_offline'
      WHERE NOT ds.is_online AND NOT d.is_disabled AND ds.offline_since > now() - interval '7 days'
        AND COALESCE(a.is_enabled, true)
        AND ds.offline_since < now() - make_interval(mins => COALESCE(a.threshold, 30))
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = da.user_id AND n.device_id = ds.device_id
                         AND n.type = 'device_offline' AND n.created_at >= ds.offline_since)`,
  );
  for (const r of rows) {
    const mins = Math.round((Date.now() - new Date(r.offline_since).getTime()) / 60000);
    await alerts.deliver(r.user_id, r.device_id, 'device_offline',
      { title: `${r.name} is offline`, body: `No data for ${mins} minutes.` },
      { timezone: r.timezone, quiet: alerts.inQuietHours(r, r.timezone), cooldown: false });
  }
}

let lastStats = '';
async function pushAdminStats() {
  const io = realtime.io;
  if (!io || !io.sockets.adapter.rooms.get('admin')) return;
  const { stats } = require('../routes/admin');
  const s = await stats();
  const json = JSON.stringify(s);
  if (json !== lastStats) {
    lastStats = json;
    realtime.toAdmin('admin:stats', s);
  }
}

async function cleanup() {
  const r = await Promise.all([
    db.query(`DELETE FROM device_commands WHERE created_at < now() - interval '1 year'`),
    db.query(`DELETE FROM notifications WHERE created_at < now() - interval '1 year'`),
    db.query(`DELETE FROM device_events WHERE occurred_at < now() - interval '2 years'`),
    db.query(`DELETE FROM otp_codes WHERE expires_at < now() - interval '1 day'`),
    db.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`),
    db.query(`DELETE FROM device_invites WHERE expires_at < now() - interval '30 days' AND accepted_at IS NULL`),
  ]);
  logger.info({ deleted: r.map((x) => x.rowCount) }, 'nightly cleanup');
}

function start() {
  // align the timer job to the start of each minute
  const msToMinute = 60_000 - (Date.now() % 60_000) + 500;
  const first = setTimeout(() => {
    runTimers().catch((err) => logger.error({ err }, 'timers failed'));
    every(60_000, 'timers', () => runTimers());
  }, msToMinute);
  timersHandles.push(first);
  every(60_000, 'offline-alerts', offlineAlerts);
  every(5_000, 'command-expiry', () => commands.expireDue());
  every(15_000, 'stale-devices', () => live.sweepStale());
  every(30_000, 'long-runs', checkLongRuns);
  every(10_000, 'admin-stats', pushAdminStats);
  every(6 * 3600_000, 'cleanup', cleanup);
}

function stop() {
  timersHandles.forEach((h) => { clearInterval(h); clearTimeout(h); });
}

module.exports = { start, stop, runTimers, checkLongRuns, offlineAlerts, cleanup };
