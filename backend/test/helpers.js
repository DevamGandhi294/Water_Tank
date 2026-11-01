// Test helpers: HTTP client, fake ESP over MQTT, Socket.IO client, DB access.
// Run against the Docker dev stack: docker compose up -d, then npm test.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const mqtt = require('mqtt');
const { io } = require('socket.io-client');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const MQTT_URL = process.env.TEST_MQTT_URL || 'mqtt://localhost:1883';
const API = `${BASE}/api/v1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
const randomPhone = () => `+9198${uniq().slice(-8)}`;
const randomMac = () => Array.from({ length: 6 }, (_v, i) => (i === 0 ? 0x02 : Math.floor(Math.random() * 256)).toString(16).padStart(2, '0')).join(':').toUpperCase();

async function api(method, p, { token, body, form, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(p.startsWith('http') ? p : `${API}${p}`, { method, headers, body: payload });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function db() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c;
}

async function makeAdmin(phone, password) {
  const c = await db();
  try {
    await c.query(
      `INSERT INTO users (full_name, phone, password_hash, role, phone_verified_at) VALUES ('Test Admin', $1, $2, 'super_admin', now())
       ON CONFLICT (phone) DO UPDATE SET role = 'super_admin', password_hash = EXCLUDED.password_hash`,
      [phone, await bcrypt.hash(password, 4)],
    );
  } finally { await c.end(); }
}

async function registerAndLogin(name = 'Test User') {
  const phone = randomPhone();
  const r = await api('POST', '/auth/register', { body: { fullName: name, phone, password: 'secret123', deviceLabel: 'test' } });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  return { phone, token: r.body.accessToken, refreshToken: r.body.refreshToken, user: r.body.user };
}

// Fake ESP main board. Answers cmd / settings / ota like the real firmware should.
class FakeDevice {
  constructor(mac, { autoAck = true, password } = {}) {
    this.username = mac.replace(/:/g, '').toLowerCase();
    this.autoAck = autoAck;
    this.password = password;
    this.received = [];
    this.state = { st: 'WORK', pump: 0, cm: 100, rssi: -60, up: 10, fw: '1.3', snd: 1 };
    this.settings = null;
  }
  topic(s) { return `wt/${this.username}/${s}`; }
  connect() {
    return new Promise((resolve, reject) => {
      const opts = {
        username: this.username, clientId: this.username, reconnectPeriod: 0, clean: true,
        will: { topic: this.topic('status'), payload: 'offline', qos: 1, retain: true },
      };
      // go-auth needs a non-empty password; the backend ignores it (MAC-only login). Convention: the MAC itself.
      opts.password = this.password === undefined ? this.username : this.password;
      this.c = mqtt.connect(MQTT_URL, opts);
      this.c.once('connect', async () => {
        this.c.on('message', (t, buf) => this.onMessage(t, buf.toString()));
        await this.c.subscribeAsync([this.topic('cmd'), this.topic('settings/set'), this.topic('ota')], { qos: 1 });
        await this.c.publishAsync(this.topic('status'), 'online', { qos: 1, retain: true });
        resolve(this);
      });
      this.c.once('error', (e) => { this.c.end(true); reject(e); });
    });
  }
  onMessage(topic, text) {
    const sub = topic.split('/').slice(2).join('/');
    let p = text;
    try { p = JSON.parse(text); } catch { /* plain */ }
    this.received.push({ sub, p, at: Date.now() });
    if (!this.autoAck) return;
    if (sub === 'cmd') {
      if (p.c === 'pump_on') {
        if (this.state.cm !== null && this.settings && this.state.cm <= this.settings.cutoff_cm) {
          this.pub('cmd/ack', { id: p.id, ok: 0, err: 'near' });
          this.pub('event', { t: 'on_refused', why: 'near' });
          return;
        }
        this.state.pump = 1;
        this.pub('cmd/ack', { id: p.id, ok: 1 });
        this.sendState();
      } else if (p.c === 'pump_off') {
        this.state.pump = 0;
        this.pub('cmd/ack', { id: p.id, ok: 1 });
        this.sendState();
      } else {
        this.pub('cmd/ack', { id: p.id, ok: 1 });
      }
    } else if (sub === 'settings/set' && p && p.v) {
      this.settings = p;
      this.pub('settings/ack', { v: p.v });
    }
  }
  pub(sub, payload, opts = { qos: 1 }) {
    return this.c.publishAsync(this.topic(sub), typeof payload === 'string' ? payload : JSON.stringify(payload), opts);
  }
  sendState(patch = {}) {
    Object.assign(this.state, patch);
    return this.pub('state', this.state, { qos: 0 });
  }
  waitFor(sub, pred = () => true, ms = 5000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const m = this.received.find((x) => x.sub === sub && pred(x.p) && !x.taken);
        if (m) { m.taken = true; return resolve(m.p); }
        if (Date.now() - start > ms) return reject(new Error(`timeout waiting for ${sub}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }
  // disconnect without DISCONNECT packet so the broker sends the last will
  kill() { this.c.stream.destroy(); }
  async close() { if (this.c) await this.c.endAsync().catch(() => {}); }
}

function socket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.events = [];
    s.onAny((ev, payload) => s.events.push({ ev, payload, at: Date.now() }));
    s.waitFor = (ev, pred = () => true, ms = 5000) => new Promise((res2, rej2) => {
      const start = Date.now();
      const tick = () => {
        const m = s.events.find((x) => x.ev === ev && !x.taken && pred(x.payload));
        if (m) { m.taken = true; return res2(m.payload); }
        if (Date.now() - start > ms) return rej2(new Error(`timeout waiting for socket ${ev}`));
        setTimeout(tick, 50);
      };
      tick();
    });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

async function until(fn, ms = 5000, step = 100) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  throw new Error('condition not met in time');
}

module.exports = { api, db, makeAdmin, registerAndLogin, FakeDevice, socket, sleep, until, randomPhone, randomMac, BASE, API, MQTT_URL };
