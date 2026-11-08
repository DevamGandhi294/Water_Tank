// Live device channel: MQTT (ESP) -> backend -> Socket.IO (app, admin).
//
// Keeps one in-memory entry per device with its latest state and the settings
// needed for level %. Postgres device_state is written only when something
// visible changed, or every STATE_HEARTBEAT_S, so a device sending every 5 s
// does not cost a write every 5 s.
const config = require('../config');
const db = require('../db');
const logger = require('../logger');
const mqtt = require('./mqtt');
const realtime = require('./realtime');
const events = require('./events');
const alerts = require('./alerts');
const pumpRuns = require('./pumpRuns');
const commands = require('./commands');
const settingsSync = require('./settingsSync');
const ota = require('./ota');
const { levelPct, iso } = require('../lib/format');

const byUsername = new Map(); // mqtt_username -> deviceId
const cache = new Map(); // deviceId -> entry

const STATUSES = new Set(['WORK', 'DOWN', 'FAULT', 'CONFIG', 'OTA', 'UNKNOWN']);
function normStatus(st) {
  const s = String(st || '').toUpperCase().trim();
  if (s.startsWith('CONFIG')) return 'CONFIG';
  if (s.startsWith('OTA')) return 'OTA';
  return STATUSES.has(s) ? s : 'UNKNOWN';
}

async function load(deviceId) {
  const r = await db.one(
    `SELECT d.id, d.mqtt_username, d.name, d.serial_no, d.is_disabled, d.timezone,
            s.tank_height_cm, s.cutoff_distance_cm, s.auto_mode,
            st.is_online, st.status, st.pump_on, st.distance_cm, st.level_pct, st.fw_version,
            st.wifi_rssi, st.uptime_s, st.last_seen_at, st.online_since, st.offline_since, st.sender_ok
       FROM devices d
       LEFT JOIN device_settings s ON s.device_id = d.id
       LEFT JOIN device_state st ON st.device_id = d.id
      WHERE d.id = $1`,
    [deviceId],
  );
  if (!r) return null;
  const e = {
    id: r.id,
    username: r.mqtt_username,
    name: r.name || r.serial_no,
    disabled: r.is_disabled,
    settings: { tank_height_cm: r.tank_height_cm, cutoff_distance_cm: r.cutoff_distance_cm ?? 25, auto_mode: r.auto_mode },
    state: {
      is_online: !!r.is_online,
      status: r.status || 'UNKNOWN',
      pump_on: !!r.pump_on,
      distance_cm: r.distance_cm,
      level_pct: r.level_pct,
      fw_version: r.fw_version,
      wifi_rssi: r.wifi_rssi,
      uptime_s: r.uptime_s,
      last_seen_at: r.last_seen_at,
      online_since: r.online_since,
      offline_since: r.offline_since,
      sender_ok: r.sender_ok,
    },
    lastDbWrite: Date.now(),
    lock: Promise.resolve(),
  };
  cache.set(deviceId, e);
  byUsername.set(e.username, deviceId);
  return e;
}

async function get(deviceId) {
  return cache.get(deviceId) || load(deviceId);
}

async function idForUsername(username) {
  if (byUsername.has(username)) return byUsername.get(username);
  const r = await db.one('SELECT id FROM devices WHERE mqtt_username = $1', [username]);
  if (!r) return null;
  byUsername.set(username, r.id);
  return r.id;
}

// drop cached data after admin edits (settings / disabled / delete)
function invalidate(deviceId) {
  const e = cache.get(deviceId);
  if (e) byUsername.delete(e.username);
  cache.delete(deviceId);
}

function statePayload(e) {
  return {
    deviceId: e.id,
    online: e.state.is_online,
    status: e.state.status,
    pumpOn: e.state.pump_on,
    distanceCm: e.state.distance_cm,
    levelPct: e.state.level_pct,
    lastSeenAt: iso(e.state.last_seen_at),
  };
}

// fresh state for REST responses (overlays the in-memory values, which may be newer than the DB)
async function stateFor(deviceId) {
  const e = await get(deviceId);
  return e ? e.state : null;
}

async function writeState(e) {
  const s = e.state;
  await db.query(
    `INSERT INTO device_state (device_id, is_online, status, pump_on, distance_cm, level_pct, fw_version,
                               wifi_rssi, uptime_s, last_seen_at, online_since, offline_since, sender_ok, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (device_id) DO UPDATE SET
       is_online = EXCLUDED.is_online, status = EXCLUDED.status, pump_on = EXCLUDED.pump_on,
       distance_cm = EXCLUDED.distance_cm, level_pct = EXCLUDED.level_pct, fw_version = EXCLUDED.fw_version,
       wifi_rssi = EXCLUDED.wifi_rssi, uptime_s = EXCLUDED.uptime_s, last_seen_at = EXCLUDED.last_seen_at,
       online_since = EXCLUDED.online_since, offline_since = EXCLUDED.offline_since,
       sender_ok = EXCLUDED.sender_ok, updated_at = now()`,
    [e.id, s.is_online, s.status, s.pump_on, s.distance_cm, s.level_pct, s.fw_version, s.wifi_rssi,
      s.uptime_s, s.last_seen_at, s.online_since, s.offline_since, s.sender_ok],
  );
  e.lastDbWrite = Date.now();
}

// serialize work per device so two MQTT messages never race on the same entry
function withLock(e, fn) {
  const run = e.lock.then(fn, fn);
  e.lock = run.catch(() => {});
  return run;
}

async function markOnline(e) {
  if (e.state.is_online) return false;
  const wasOffline = !!e.state.offline_since;
  e.state.is_online = true;
  e.state.online_since = new Date();
  e.state.offline_since = null;
  await writeState(e);
  realtime.toDevice(e.id, 'device:online', { deviceId: e.id, online: true, at: iso(e.state.online_since) });
  if (wasOffline) {
    await events.resolve(e.id, ['offline']);
    await events.add(e.id, 'online', { message: 'Back online' });
  }
  // anything the device missed while offline
  const s = await db.one('SELECT version, applied_version FROM device_settings WHERE device_id = $1', [e.id]);
  if (s && s.version > s.applied_version) await settingsSync.publish(e.id);
  await ota.sendPendingFor(e.id);
  return true;
}

async function markOffline(e, why = 'lwt') {
  if (!e.state.is_online) return false;
  e.state.is_online = false;
  e.state.offline_since = new Date();
  await writeState(e);
  realtime.toDevice(e.id, 'device:online', { deviceId: e.id, online: false, at: iso(e.state.offline_since) });
  await events.add(e.id, 'offline', { severity: 'warning', message: 'Went offline', data: { why } });
  await commands.failOpenFor(e.id, 'device_offline');
  realtime.emitState(statePayload(e));
  return true;
}

const STATUS_EVENTS = {
  FAULT: { type: 'sender_fault', severity: 'critical', message: 'Sender board not in range (FAULT)', alert: 'The sender board is not in range, so the level is unknown.' },
  DOWN: { type: 'sensor_down', severity: 'warning', message: 'Ultrasonic sensor has no echo (DOWN)', alert: 'The ultrasonic sensor gives no reading.' },
  CONFIG: { type: 'config_mode', severity: 'info', message: 'Main board is in Wi-Fi config mode' },
};

async function onStatusChange(e, from, to) {
  if ((from === 'FAULT' || from === 'DOWN') && to !== from) await events.resolve(e.id, ['sender_fault', 'sensor_down']);
  const def = STATUS_EVENTS[to];
  if (!def) return;
  const ev = await events.add(e.id, def.type, { severity: def.severity, message: def.message, data: { from, to } });
  if (def.alert) {
    await alerts.notify(e.id, 'sensor_fault', { title: `${e.name}: sensor fault`, body: def.alert, eventId: ev.id });
  }
}

// wt/<d>/state {"st":"WORK","pump":1,"cm":62.4,"rssi":-61,"up":86400,"fw":"1.3","snd":1}
async function handleState(e, p) {
  const s = e.state;
  const prev = { ...s };
  const now = new Date();
  s.last_seen_at = now;
  if (p.st !== undefined) s.status = normStatus(p.st);
  if (p.pump !== undefined) s.pump_on = p.pump === 1 || p.pump === true || p.pump === '1';
  if (p.cm !== undefined) {
    const cm = Number(p.cm);
    s.distance_cm = p.cm === null || !Number.isFinite(cm) || cm < 0 ? null : Math.round(cm * 10) / 10;
  }
  if (p.rssi !== undefined) s.wifi_rssi = Number.isFinite(Number(p.rssi)) ? Math.round(Number(p.rssi)) : null;
  if (p.up !== undefined) s.uptime_s = Number.isFinite(Number(p.up)) ? Math.round(Number(p.up)) : null;
  if (p.fw !== undefined && p.fw !== null) s.fw_version = String(p.fw).slice(0, 20);
  if (p.snd !== undefined) s.sender_ok = p.snd === 1 || p.snd === true;
  s.level_pct = levelPct(s.distance_cm, e.settings.tank_height_cm, e.settings.cutoff_distance_cm);

  if (!prev.is_online) await markOnline(e);

  const changed =
    prev.status !== s.status || prev.pump_on !== s.pump_on || prev.level_pct !== s.level_pct ||
    prev.fw_version !== s.fw_version || prev.sender_ok !== s.sender_ok ||
    (prev.distance_cm == null) !== (s.distance_cm == null) ||
    Math.abs((prev.distance_cm || 0) - (s.distance_cm || 0)) >= 0.5;
  if (changed || Date.now() - e.lastDbWrite > config.stateHeartbeatS * 1000) await writeState(e);

  if (prev.status !== s.status) await onStatusChange(e, prev.status, s.status);
  if (prev.pump_on !== s.pump_on) {
    if (s.pump_on) await pumpRuns.opened(e.id, s);
    else await pumpRuns.closed(e.id, s, s.status === 'FAULT' || s.status === 'DOWN' ? 'fault' : null);
  }
  if (prev.fw_version !== s.fw_version && s.fw_version) {
    await db.query(
      `UPDATE device_boards SET fw_version = $2 WHERE device_id = $1 AND role = 'main' AND replaced_at IS NULL`,
      [e.id, s.fw_version],
    );
    await ota.checkFirmware(e.id, s.fw_version);
  }
  if (prev.level_pct !== s.level_pct) await alerts.checkLevel(e.id, e.name, prev.level_pct, s.level_pct);

  realtime.emitState(statePayload(e));
}

// wt/<d>/event {"t":"auto_cutoff","cm":24.8} | {"t":"pump","on":1,"src":"button"} | {"t":"reboot","reason":"power"} | {"t":"on_refused","why":"near"}
async function handleEvent(e, p) {
  const t = String(p.t || '');
  switch (t) {
    case 'auto_cutoff': {
      pumpRuns.setStopHint(e.id, { reason: 'auto_cutoff' });
      const cm = Number(p.cm);
      await events.add(e.id, 'auto_cutoff', { message: `Auto cutoff at ${Number.isFinite(cm) ? cm : e.settings.cutoff_distance_cm} cm`, data: { cm: Number.isFinite(cm) ? cm : null } });
      if (e.state.pump_on) {
        e.state.pump_on = false;
        if (Number.isFinite(cm)) e.state.distance_cm = cm;
        e.state.level_pct = levelPct(e.state.distance_cm, e.settings.tank_height_cm, e.settings.cutoff_distance_cm);
        await writeState(e);
        await pumpRuns.closed(e.id, e.state);
        realtime.emitState(statePayload(e));
      }
      break;
    }
    case 'pump': {
      const on = p.on === 1 || p.on === true || p.on === '1';
      const src = ['button', 'app', 'auto', 'timer', 'admin', 'system'].includes(p.src) ? p.src : null;
      if (on) {
        if (src === 'button') pumpRuns.clearStartHint(e.id);
        if (!e.state.pump_on) {
          e.state.pump_on = true;
          await writeState(e);
          await pumpRuns.opened(e.id, e.state, src);
          realtime.emitState(statePayload(e));
        }
      } else {
        if (src === 'button') pumpRuns.setStopHint(e.id, { reason: 'button' });
        if (e.state.pump_on) {
          e.state.pump_on = false;
          await writeState(e);
          await pumpRuns.closed(e.id, e.state);
          realtime.emitState(statePayload(e));
        }
      }
      break;
    }
    case 'reboot':
      await events.add(e.id, 'reboot', { message: `Rebooted (${p.reason || 'unknown'})`, data: { reason: p.reason || null } });
      // a run that was open before the reboot ends with power_loss (closed now, or by the next state)
      pumpRuns.setStopHint(e.id, { reason: p.reason === 'power' ? 'power_loss' : 'unknown' });
      if (!e.state.pump_on) await pumpRuns.closed(e.id, e.state);
      break;
    case 'on_refused':
      await events.add(e.id, 'on_refused', {
        severity: 'warning',
        message: p.why === 'near' ? 'Pump ON refused: tank already full' : `Pump ON refused (${p.why || 'unknown'})`,
        data: { why: p.why || null },
        oneOff: true,
      });
      break;
    case 'config_mode':
      await events.add(e.id, 'config_mode', { message: 'Main board is in Wi-Fi config mode' });
      break;
    default:
      logger.debug({ device: e.id, p }, 'unknown device event');
  }
}

async function handle(username, sub, payload) {
  const deviceId = await idForUsername(username);
  if (!deviceId) return logger.warn({ username, sub }, 'mqtt message from unknown device');
  const e = await get(deviceId);
  if (!e || e.disabled) return;
  await withLock(e, async () => {
    // the 'offline' last will comes from the broker, not from the board
    const fromBoard = !(sub === 'status' && payload === 'offline');
    if (fromBoard) e.state.last_seen_at = new Date();
    switch (sub) {
      case 'status':
        if (payload === 'online') {
          if (!(await markOnline(e))) realtime.emitState(statePayload(e));
        } else if (payload === 'offline') {
          await markOffline(e, 'lwt');
        }
        break;
      case 'state':
        if (payload && typeof payload === 'object') await handleState(e, payload);
        break;
      case 'event':
        if (payload && typeof payload === 'object') {
          if (!e.state.is_online) await markOnline(e);
          await handleEvent(e, payload);
        }
        break;
      case 'cmd/ack':
        await commands.ack(deviceId, payload);
        break;
      case 'settings/ack':
        await settingsSync.ack(deviceId, payload);
        break;
      case 'ota/status':
        await ota.handleStatus(deviceId, payload);
        break;
      default:
        break;
    }
    if (fromBoard && e.state.is_online) realtime.emitState(statePayload(e));
  });
}

// Settings changed from the API: update level % with the new height / cutoff
async function settingsChanged(deviceId, s) {
  const e = await get(deviceId);
  if (!e) return;
  await withLock(e, async () => {
    e.settings = { tank_height_cm: s.tank_height_cm, cutoff_distance_cm: s.cutoff_distance_cm, auto_mode: s.auto_mode };
    const pct = levelPct(e.state.distance_cm, s.tank_height_cm, s.cutoff_distance_cm);
    if (pct !== e.state.level_pct) {
      e.state.level_pct = pct;
      await writeState(e);
      realtime.emitState(statePayload(e));
    }
  });
}

// no message for DEVICE_STALE_S while marked online: LWT was lost, mark offline
async function sweepStale() {
  const cutoff = Date.now() - config.deviceStaleS * 1000;
  const rows = await db.many(
    `SELECT device_id FROM device_state WHERE is_online AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $1))`,
    [config.deviceStaleS],
  );
  for (const r of rows) {
    const e = await get(r.device_id);
    if (!e) continue;
    if (e.state.last_seen_at && new Date(e.state.last_seen_at).getTime() > cutoff) continue; // newer in memory
    await withLock(e, () => markOffline(e, 'stale'));
  }
  // in-memory entries that are newer than the DB heartbeat
  for (const e of cache.values()) {
    if (e.state.is_online && e.state.last_seen_at && new Date(e.state.last_seen_at).getTime() < cutoff) {
      await withLock(e, () => markOffline(e, 'stale'));
    }
  }
}

function start() {
  mqtt.onMessage(handle);
  realtime.setStateProvider(async (id) => {
    const e = await get(id);
    return e ? statePayload(e) : null;
  });
}

module.exports = { start, get, stateFor, invalidate, statePayload, settingsChanged, sweepStale, handle, normStatus };
