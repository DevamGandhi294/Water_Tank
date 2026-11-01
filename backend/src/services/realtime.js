// Socket.IO for the app and the admin panel.
// Rooms: device:<id> (people with access), user:<id> (one person), admin (super_admin).
const { Server } = require('socket.io');
const config = require('../config');
const logger = require('../logger');
const { loadUserFromToken } = require('../middleware/auth');
const { accessibleDeviceIds } = require('./access');

let io = null;
let stateProvider = async () => null; // (deviceId) -> device:state payload, set by live.js

function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) throw new Error('TOKEN_REQUIRED');
      socket.user = await loadUserFromToken(token);
      next();
    } catch (err) {
      const e = new Error(err.code || err.message || 'UNAUTHORIZED');
      e.data = { code: err.code || 'UNAUTHORIZED' };
      next(e);
    }
  });

  io.on('connection', (socket) => {
    const u = socket.user;
    socket.join(`user:${u.id}`);
    if (u.role === 'super_admin') socket.join('admin');

    // tell the client when its access token runs out, then drop it; the app refreshes and reconnects
    const msLeft = u.tokenExp * 1000 - Date.now();
    const expiry = setTimeout(() => {
      socket.emit('auth:expired');
      socket.disconnect(true);
    }, Math.max(0, Math.min(msLeft, 2 ** 31 - 1)));
    socket.on('disconnect', () => clearTimeout(expiry));

    socket.on('device:subscribe', async (msg, ack) => {
      try {
        const ids = Array.isArray(msg && msg.deviceIds) ? msg.deviceIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200) : [];
        const allowed = await accessibleDeviceIds(u, ids);
        const states = [];
        for (const id of allowed) {
          socket.join(`device:${id}`);
          const s = await stateProvider(id);
          if (s) {
            states.push(s);
            socket.emit('device:state', s);
          }
        }
        if (typeof ack === 'function') ack({ ok: true, deviceIds: allowed, states });
      } catch (err) {
        logger.warn({ err }, 'device:subscribe failed');
        if (typeof ack === 'function') ack({ ok: false });
      }
    });

    socket.on('device:unsubscribe', (msg, ack) => {
      const ids = Array.isArray(msg && msg.deviceIds) ? msg.deviceIds : [];
      ids.forEach((id) => socket.leave(`device:${id}`));
      if (typeof ack === 'function') ack({ ok: true });
    });
  });

  return io;
}

const setStateProvider = (fn) => { stateProvider = fn; };

function toDevice(deviceId, event, payload) {
  if (io) io.to(`device:${deviceId}`).to('admin').emit(event, payload);
}
function toDeviceMembers(deviceId, event, payload) {
  if (io) io.to(`device:${deviceId}`).emit(event, payload);
}
function toUser(userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
}
function toAdmin(event, payload) {
  if (io) io.to('admin').emit(event, payload);
}

// access removed: drop this user's sockets out of the device room
function removeFromDevice(userId, deviceId) {
  if (!io) return;
  io.in(`user:${userId}`).socketsLeave(`device:${deviceId}`);
  toUser(userId, 'access:changed', { deviceId, access: null });
}
function accessChanged(userId, deviceId, access) {
  toUser(userId, 'access:changed', { deviceId, access });
}
function disconnectUser(userId) {
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
}

// Per-device throttle: at most one device:state per second, only when it changed.
const throttle = new Map(); // deviceId -> { lastJson, lastAt, timer, pending }
function emitState(payload) {
  const id = payload.deviceId;
  const json = JSON.stringify({ ...payload, lastSeenAt: undefined });
  let t = throttle.get(id);
  if (!t) { t = { lastJson: null, lastAt: 0, timer: null, pending: null }; throttle.set(id, t); }
  if (json === t.lastJson && !t.pending) return;
  const now = Date.now();
  const send = (p) => {
    t.lastJson = JSON.stringify({ ...p, lastSeenAt: undefined });
    t.lastAt = Date.now();
    t.pending = null;
    t.timer = null;
    toDevice(id, 'device:state', p);
  };
  if (now - t.lastAt >= 1000 && !t.timer) return send(payload);
  t.pending = payload;
  if (!t.timer) t.timer = setTimeout(() => t.pending && send(t.pending), 1000 - (now - t.lastAt));
}

async function close() {
  if (io) await new Promise((r) => io.close(() => r()));
}

module.exports = {
  init, setStateProvider, toDevice, toDeviceMembers, toUser, toAdmin, removeFromDevice,
  accessChanged, disconnectUser, emitState, close, get io() { return io; },
};
