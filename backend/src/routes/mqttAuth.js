// Mosquitto asks the backend who may connect and which topics they may use
// (mosquitto-go-auth HTTP backend, JSON params, status response: 200 = allow, 403 = deny).
//
// Devices: username = main board MAC as 12 lowercase hex chars, client id = the same,
//          password is ignored (MAC-only login, decision 2026-11-01). The device must be
//          registered by the admin and not disabled.
// Backend: MQTT_BACKEND_USERNAME / MQTT_BACKEND_PASSWORD, superuser.
//
// This router is mounted at /mqtt and must never be exposed through Nginx.
const express = require('express');
const config = require('../config');
const db = require('../db');
const logger = require('../logger');
const { safeEqual } = require('../lib/crypto');

const router = express.Router();

const PRIVATE = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$/;

router.use((req, res, next) => {
  const ip = req.socket.remoteAddress || '';
  if (!PRIVATE.test(ip)) return res.status(403).end();
  if (config.mqtt.authHookToken && !safeEqual(req.query.token || '', config.mqtt.authHookToken)) return res.status(403).end();
  next();
});

const isBackend = (u) => u === config.mqtt.username;
const DEVICE_PUB = new Set(['status', 'state', 'event', 'cmd/ack', 'settings/ack', 'ota/status']);
const DEVICE_SUB = new Set(['cmd', 'settings/set', 'ota']);

// short cache so a burst of reconnects does not hit Postgres every time
const cache = new Map(); // username -> { ok, at }
async function deviceAllowed(username) {
  const c = cache.get(username);
  if (c && Date.now() - c.at < 10_000) return c.ok;
  const d = await db.one('SELECT is_disabled FROM devices WHERE mqtt_username = $1', [username]);
  const ok = !!d && !d.is_disabled;
  cache.set(username, { ok, at: Date.now() });
  return ok;
}
const forget = (username) => cache.delete(username);

router.post('/user', async (req, res) => {
  const { username = '', password = '', clientid = '' } = req.body || {};
  if (isBackend(username)) {
    return res.status(safeEqual(password, config.mqtt.password) ? 200 : 403).end();
  }
  if (!/^[0-9a-f]{12}$/.test(username) || clientid !== username) {
    logger.info({ username, clientid }, 'mqtt login refused: bad username/client id');
    return res.status(403).end();
  }
  const ok = await deviceAllowed(username);
  if (!ok) logger.info({ username }, 'mqtt login refused: device not registered or disabled');
  res.status(ok ? 200 : 403).end();
});

router.post('/superuser', (req, res) => {
  res.status(isBackend((req.body || {}).username) ? 200 : 403).end();
});

// acc: 1 = read (deliver to client), 2 = publish, 4 = subscribe
router.post('/acl', async (req, res) => {
  const { username = '', topic = '', acc } = req.body || {};
  if (isBackend(username)) return res.status(200).end();
  const prefix = `wt/${username}/`;
  if (!/^[0-9a-f]{12}$/.test(username) || !topic.startsWith(prefix) || !(await deviceAllowed(username))) return res.status(403).end();
  const rest = topic.slice(prefix.length);
  const a = Number(acc);
  let ok = false;
  if (a === 2) ok = DEVICE_PUB.has(rest);
  else if (a === 1) ok = DEVICE_SUB.has(rest);
  else if (a === 4) ok = DEVICE_SUB.has(rest) || rest === '#' || rest === '+';
  res.status(ok ? 200 : 403).end();
});

module.exports = { router, forget };
