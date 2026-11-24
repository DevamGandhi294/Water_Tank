// "Show logs" in the admin panel. The boards keep their last ~100 Serial Monitor lines in RAM.
//
// Main board (fw 4.4+), over MQTT:
//   wt/<d>/cmd   -> ESP  {"id":0,"c":"logs"}          send the last 100 lines
//                        {"id":0,"c":"log_live_on"}   stream new lines for 10 min (again = 10 more min)
//                        {"id":0,"c":"log_live_off"}
//   wt/<d>/event ESP ->  {"t":"log","k":"dump","id":123,"p":0,"last":0,"fw":"4.4","up":5400,"text":"..."}
//                        {"t":"log","k":"live","text":"..."}
//   The broker allows 4 KB per message, so a dump arrives in parts (p = 0, 1, ...; last = 1 on
//   the final one). These commands are not acked and not stored in device_commands.
//
// Sender board (fw 5.2+), which has Wi-Fi only for a few seconds at boot and every 6 h:
//   the admin asks, the next GET /ota/sender answers with header X-Send-Log: 1, and the sender
//   POSTs its lines to /ota/sender/log (routes/senderOta.js).
//
// Nothing is written to Postgres: only the latest log of each board is kept in memory.
const realtime = require('./realtime');

const MAX_TEXT = 64 * 1024;
const LIVE_MS = 10 * 60_000;
const SENDER_WAIT_MS = 24 * 3600_000; // a sender request is forgotten after a day

const store = new Map(); // deviceId -> { main, sender, partial, liveUntil, senderRequestedAt }

function entry(deviceId) {
  let e = store.get(deviceId);
  if (!e) {
    e = { main: null, sender: null, partial: null, liveUntil: 0, senderRequestedAt: 0, mainRequestedAt: 0 };
    store.set(deviceId, e);
  }
  return e;
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// wt/<d>/event {"t":"log",...} from the main board
function onMainEvent(deviceId, p) {
  const text = typeof p.text === 'string' ? p.text : '';
  if (p.k === 'live') {
    if (text) realtime.toAdmin('device:log_live', { deviceId, text });
    return;
  }
  const e = entry(deviceId);
  const id = String(p.id ?? '');
  if (!e.partial || e.partial.id !== id) e.partial = { id, parts: [], startedAt: Date.now() };
  const part = Math.max(0, Math.min(200, parseInt(p.p, 10) || 0));
  e.partial.parts[part] = text;
  if (!(p.last === 1 || p.last === true || p.last === '1')) return;

  const parts = e.partial.parts;
  let missing = 0;
  for (let i = 0; i < parts.length; i++) if (parts[i] === undefined) missing++;
  let full = parts.map((t) => t ?? '').join('');
  if (full.length > MAX_TEXT) full = full.slice(-MAX_TEXT);
  e.main = { text: full, receivedAt: Date.now(), fw: p.fw ? String(p.fw).slice(0, 20) : null, uptimeS: num(p.up), missingParts: missing };
  e.partial = null;
  realtime.toAdmin('device:log', { deviceId, board: 'main' });
}

function mainRequested(deviceId) {
  entry(deviceId).mainRequestedAt = Date.now();
}

function setLive(deviceId, on) {
  const e = entry(deviceId);
  e.liveUntil = on ? Date.now() + LIVE_MS : 0;
  return e.liveUntil;
}

function senderRequested(deviceId) {
  entry(deviceId).senderRequestedAt = Date.now();
}

// should the sender upload its log at this check-in?
function senderWanted(deviceId) {
  const e = store.get(deviceId);
  if (!e || !e.senderRequestedAt) return false;
  if (Date.now() - e.senderRequestedAt > SENDER_WAIT_MS) return false;
  return !e.sender || e.sender.receivedAt < e.senderRequestedAt;
}

function onSenderLog(deviceId, text, fw) {
  const e = entry(deviceId);
  let t = String(text || '');
  if (t.length > MAX_TEXT) t = t.slice(-MAX_TEXT);
  e.sender = { text: t, receivedAt: Date.now(), fw: fw || null, uptimeS: null, missingParts: 0 };
  e.senderRequestedAt = 0;
  realtime.toAdmin('device:log', { deviceId, board: 'sender' });
}

const out = (b) => b && { text: b.text, receivedAt: iso(b.receivedAt), fw: b.fw, uptimeS: b.uptimeS, missingParts: b.missingParts };

function get(deviceId) {
  const e = store.get(deviceId);
  if (!e) return { main: null, sender: null, liveUntil: null, mainRequestedAt: null, senderRequestedAt: null };
  return {
    main: out(e.main),
    sender: out(e.sender),
    liveUntil: e.liveUntil > Date.now() ? iso(e.liveUntil) : null,
    mainRequestedAt: iso(e.mainRequestedAt),
    senderRequestedAt: senderWanted(deviceId) ? iso(e.senderRequestedAt) : null,
  };
}

function forget(deviceId) {
  store.delete(deviceId);
}

module.exports = { onMainEvent, mainRequested, setLive, senderRequested, senderWanted, onSenderLog, get, forget, LIVE_MS };
