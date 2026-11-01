// End-to-end test against the Docker dev stack (backend + Postgres + Mosquitto with go-auth).
// Follows the "suggested test order" in docs/API.md section 15, with a fake ESP over MQTT.
//   docker compose up -d --build && cd backend && npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const S = {}; // shared state between steps
const ADMIN_PHONE = '+919000000001';
const ADMIN_PW = 'adminpass1';

before(async () => {
  await h.makeAdmin(ADMIN_PHONE, ADMIN_PW);
});

after(async () => {
  for (const d of [S.dev, S.dev2]) if (d) await d.close();
  for (const s of [S.sock, S.sockB, S.sockAdmin]) if (s) s.close();
});

test('health', async () => {
  const r = await h.api('GET', `${h.BASE}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.body.db, true);
  assert.equal(r.body.mqtt, true);
});

// ---------------------------------------------------------------- 1. auth
test('1. register, login, me, refresh, sessions', async () => {
  S.phone = h.randomPhone();
  let r = await h.api('POST', '/auth/register', { body: { fullName: 'Devv', phone: S.phone, password: 'secret123' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.otpSent, false); // no SMS provider: usable at once
  assert.ok(r.body.accessToken);

  r = await h.api('POST', '/auth/register', { body: { fullName: 'Devv', phone: S.phone, password: 'secret123' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'PHONE_TAKEN');

  r = await h.api('POST', '/auth/register', { body: { fullName: 'X', phone: '12345', password: 'secret123' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_PHONE');

  r = await h.api('POST', '/auth/register', { body: { fullName: 'X', phone: h.randomPhone(), password: 'short' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, 'password');

  r = await h.api('POST', '/auth/login', { body: { phone: S.phone, password: 'wrong-pass' } });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'BAD_CREDENTIALS');

  // the app may send the number with spaces
  const spaced = `${S.phone.slice(0, 3)} ${S.phone.slice(3, 8)} ${S.phone.slice(8)}`;
  r = await h.api('POST', '/auth/login', { body: { phone: spaced, password: 'secret123', deviceLabel: 'Pixel 7' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  S.token = r.body.accessToken;
  S.refresh = r.body.refreshToken;
  assert.equal(r.body.user.fullName, 'Devv');
  assert.equal(r.body.user.role, 'user');
  assert.equal(r.body.user.hasPassword, true);

  r = await h.api('GET', '/me', { token: S.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.phone, S.phone);
  assert.equal(r.body.unreadNotifications, 0);
  S.userId = r.body.id;

  r = await h.api('GET', '/me');
  assert.equal(r.status, 401);

  // refresh rotates; the old refresh token then fails and logs out everywhere
  r = await h.api('POST', '/auth/refresh', { body: { refreshToken: S.refresh } });
  assert.equal(r.status, 200);
  const newRefresh = r.body.refreshToken;
  assert.notEqual(newRefresh, S.refresh);
  r = await h.api('POST', '/auth/refresh', { body: { refreshToken: S.refresh } });
  assert.equal(r.status, 401);
  // reuse detected: token_version bumped -> old access token is dead too
  r = await h.api('GET', '/me', { token: S.token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'TOKEN_REVOKED');

  r = await h.api('POST', '/auth/login', { body: { phone: S.phone, password: 'secret123', deviceLabel: 'Pixel 7' } });
  S.token = r.body.accessToken;
  S.refresh = r.body.refreshToken;

  r = await h.api('GET', '/me/sessions', { token: S.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((s) => s.current && s.deviceLabel === 'Pixel 7'));

  r = await h.api('PATCH', '/me', { token: S.token, body: { fullName: 'Devv G', email: `devv${S.phone.slice(-6)}@example.com` } });
  assert.equal(r.status, 200);
  assert.equal(r.body.fullName, 'Devv G');
  assert.equal(r.body.email, `devv${S.phone.slice(-6)}@example.com`);

  r = await h.api('POST', '/auth/otp/send', { body: { phone: S.phone, purpose: 'login' } });
  assert.equal(r.status, 501); // SMS off
  r = await h.api('POST', '/auth/google', { body: { idToken: 'x' } });
  assert.equal(r.status, 501);

  r = await h.api('POST', '/me/push-tokens', { token: S.token, body: { fcmToken: 'fake-token-1234567890', platform: 'android' } });
  assert.equal(r.status, 204);
});

test('1b. change password, logout', async () => {
  let r = await h.api('POST', '/me/password', { token: S.token, body: { currentPassword: 'nope', newPassword: 'secret456' } });
  assert.equal(r.status, 422);
  r = await h.api('POST', '/me/password', { token: S.token, body: { currentPassword: 'secret123', newPassword: 'secret456' } });
  assert.equal(r.status, 204);
  r = await h.api('POST', '/auth/login', { body: { phone: S.phone, password: 'secret456' } });
  assert.equal(r.status, 200);
  const r2 = await h.api('POST', '/auth/logout', { token: r.body.accessToken, body: { refreshToken: r.body.refreshToken } });
  assert.equal(r2.status, 204);
  r = await h.api('POST', '/auth/refresh', { body: { refreshToken: r.body.refreshToken } });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------- 2. admin registers a device
test('2. admin login + register device', async () => {
  let r = await h.api('POST', '/auth/login', { body: { phone: ADMIN_PHONE, password: ADMIN_PW } });
  assert.equal(r.status, 200);
  S.admin = r.body.accessToken;
  assert.equal(r.body.user.role, 'super_admin');

  r = await h.api('GET', '/admin/stats', { token: S.token });
  assert.equal(r.status, 403);

  S.macMain = h.randomMac();
  S.macSender = h.randomMac();
  r = await h.api('POST', '/admin/devices', { token: S.admin, body: { macMain: S.macMain.toLowerCase().replace(/:/g, '-'), macSender: S.macSender } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.serial, /^WT-\d{4}-\d{5}$/);
  assert.match(r.body.claimCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(r.body.qrPayload, `WT1:${r.body.serial}:${r.body.claimCode}`);
  assert.ok(r.body.qrPngBase64.length > 100);
  assert.equal(r.body.mqttUsername, S.macMain.replace(/:/g, '').toLowerCase());
  assert.equal(r.body.deviceSecret, undefined); // MAC-only login
  assert.equal(r.body.device.boards.find((b) => b.role === 'main').mac, S.macMain);
  S.serial = r.body.serial;
  S.claimCode = r.body.claimCode;
  S.deviceId = r.body.device.id;

  r = await h.api('POST', '/admin/devices', { token: S.admin, body: { macMain: S.macMain, macSender: h.randomMac() } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'MAC_EXISTS');
  r = await h.api('POST', '/admin/devices', { token: S.admin, body: { macMain: 'zz:11', macSender: h.randomMac() } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_MAC');

  // search by MAC without colons, and by serial
  r = await h.api('GET', `/admin/devices?q=${S.macMain.replace(/:/g, '').slice(4)}`, { token: S.admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((d) => d.id === S.deviceId));
  r = await h.api('GET', `/admin/devices?q=${S.serial}&claimed=false`, { token: S.admin });
  assert.equal(r.body.total, 1);
});

// ---------------------------------------------------------------- MQTT login rules
test('MQTT: registered MAC can connect, unknown MAC and wrong client id cannot', async () => {
  const unknown = new h.FakeDevice(h.randomMac());
  await assert.rejects(unknown.connect(), /Not authorized/);
  const badClient = new h.FakeDevice(S.macMain);
  badClient.connect = function connect() {
    return new Promise((resolve, reject) => {
      const c = require('mqtt').connect(h.MQTT_URL, { username: this.username, password: 'x', clientId: 'other', reconnectPeriod: 0 });
      c.once('connect', () => { c.end(); resolve(); });
      c.once('error', (e) => { c.end(true); reject(e); });
    });
  };
  await assert.rejects(badClient.connect(), /Not authorized/);

  S.dev = new h.FakeDevice(S.macMain);
  await S.dev.connect();
  // retained settings from registration arrive at once, ESP acks v1
  const set = await S.dev.waitFor('settings/set');
  assert.equal(set.v, 1);
  assert.equal(set.cutoff_cm, 25);
  await S.dev.sendState({ cm: 120, pump: 0 });
  await h.until(async () => {
    const x = (await h.api('GET', `/admin/devices/${S.deviceId}`, { token: S.admin })).body;
    return x.state.online && x.state.distanceCm === 120 && x.settings.appliedVersion === 1;
  });
  const d = (await h.api('GET', `/admin/devices/${S.deviceId}`, { token: S.admin })).body;
  assert.equal(d.settings.appliedVersion, 1);
  assert.equal(d.state.distanceCm, 120);
  assert.equal(d.state.levelPct, null); // no tank height yet
});

test('MQTT ACL: a device cannot publish to another device topic', async () => {
  // second device
  const mac2 = h.randomMac();
  const r = await h.api('POST', '/admin/devices', { token: S.admin, body: { macMain: mac2, macSender: h.randomMac() } });
  S.device2Id = r.body.device.id;
  S.dev2 = new h.FakeDevice(mac2);
  await S.dev2.connect();
  // dev2 tries to fake dev1's state; the broker drops it (MQTT 3.1.1 has no error back)
  await S.dev2.c.publishAsync(`wt/${S.dev.username}/state`, JSON.stringify({ st: 'FAULT', pump: 1, cm: 30 }), { qos: 1 });
  await h.sleep(500);
  const d = (await h.api('GET', `/admin/devices/${S.deviceId}`, { token: S.admin })).body;
  assert.equal(d.state.status, 'WORK');
  assert.equal(d.state.pumpOn, false);
});

// ---------------------------------------------------------------- 3. claim
test('3. claim check + claim + list', async () => {
  let r = await h.api('POST', '/devices/claim/check', { token: S.token, body: { serial: S.serial, claimCode: 'AAAA-AAAA' } });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'INVALID_CODE');

  r = await h.api('POST', '/devices/claim/check', { token: S.token, body: { qr: `WT1:${S.serial}:${S.claimCode.toLowerCase()}` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.available, true);
  assert.equal(r.body.serial, S.serial);

  r = await h.api('POST', '/devices/claim', {
    token: S.token,
    body: { serial: S.serial, claimCode: S.claimCode, name: 'Home Tank', location: 'Roof', tankHeightCm: 20, capacityLitres: 1000 },
  });
  assert.equal(r.status, 422); // height below 30 cm
  assert.equal(r.body.error.code, 'TANK_HEIGHT_INVALID');

  r = await h.api('POST', '/devices/claim', {
    token: S.token,
    body: { serial: S.serial, claimCode: S.claimCode, name: 'Home Tank', location: 'Roof', tankHeightCm: 180, capacityLitres: 1000 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.access, 'owner');
  assert.equal(r.body.name, 'Home Tank');
  assert.equal(r.body.settings.tankHeightCm, 180);
  assert.equal(r.body.timezone, 'Asia/Kolkata');

  // second person cannot claim it
  S.userB = await h.registerAndLogin('Asha');
  r = await h.api('POST', '/devices/claim/check', { token: S.userB.token, body: { serial: S.serial, claimCode: S.claimCode } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALREADY_CLAIMED');

  r = await h.api('GET', '/devices', { token: S.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  const card = r.body.items[0];
  assert.equal(card.serial, S.serial);
  assert.equal(card.state.online, true);
  // tank height set: level % = (180 - 120) / (180 - 25) * 100 = 39
  assert.equal(card.state.levelPct, 39);

  r = await h.api('GET', `/devices/${S.deviceId}`, { token: S.userB.token });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------- 4. settings
test('4. settings: cutoff validation + sync with the ESP', async () => {
  S.sock = await h.socket(S.token);
  const sub = await S.sock.emitWithAck('device:subscribe', { deviceIds: [S.deviceId, S.device2Id] });
  assert.deepEqual(sub.deviceIds, [S.deviceId]); // no access to device 2
  assert.equal(sub.states[0].deviceId, S.deviceId);

  let r = await h.api('PATCH', `/devices/${S.deviceId}/settings`, { token: S.token, body: { cutoffCm: 20 } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'CUTOFF_TOO_LOW');
  r = await h.api('PATCH', `/devices/${S.deviceId}/settings`, { token: S.token, body: { cutoffCm: 301 } });
  assert.equal(r.body.error.code, 'CUTOFF_TOO_HIGH');
  r = await h.api('PATCH', `/devices/${S.deviceId}/settings`, { token: S.token, body: { cutoffCm: 180 } });
  assert.equal(r.body.error.code, 'CUTOFF_OUTSIDE_TANK');
  r = await h.api('PATCH', `/devices/${S.deviceId}/settings`, { token: S.token, body: { lowLevelPct: 96 } });
  assert.equal(r.body.error.code, 'LEVELS_INVALID');

  S.dev.autoAck = false; // hold the ack to see "sending"
  r = await h.api('PATCH', `/devices/${S.deviceId}/settings`, { token: S.token, body: { cutoffCm: 35, maxPumpMinutes: 60 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sync, 'sending');
  assert.equal(r.body.settings.cutoffCm, 35);
  const v = r.body.settings.version;
  assert.ok(v > r.body.settings.appliedVersion);

  const set = await S.dev.waitFor('settings/set', (p) => p.v === v);
  assert.deepEqual(set, { v, cutoff_cm: 35, auto: 1, max_min: 60 });
  S.dev.settings = set;
  await S.dev.pub('settings/ack', { v });
  const sync = await S.sock.waitFor('settings:sync', (p) => p.sync === 'applied' && p.version === v);
  assert.equal(sync.appliedVersion, v);
  S.dev.autoAck = true;

  // level % now uses cutoff 35: (180-120)/(180-35) = 41
  const st = await S.sock.waitFor('device:state', (p) => p.levelPct === 41);
  assert.equal(st.distanceCm, 120);

  r = await h.api('GET', `/devices/${S.deviceId}/settings/history`, { token: S.token });
  assert.equal(r.status, 200);
  const change = r.body.items.find((x) => x.version === v);
  assert.equal(change.old.cutoffCm, 25);
  assert.equal(change.new.cutoffCm, 35);
  assert.equal(change.changedBy, 'Devv G');
  assert.ok(change.appliedAt);
});

// ---------------------------------------------------------------- 5. pump
test('5. pump ON/OFF through MQTT, pump run log', async () => {
  let r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.token, body: { action: 'on' } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.status, 'sent');
  const cmd = await S.dev.waitFor('cmd', (p) => p.id === r.body.commandId);
  assert.equal(cmd.c, 'pump_on');
  const res = await S.sock.waitFor('command:result', (p) => p.commandId === r.body.commandId);
  assert.equal(res.status, 'acked');
  const run = await S.sock.waitFor('pump:run', (p) => !p.run.endedAt);
  assert.equal(run.run.startSource, 'app');
  assert.equal(run.run.startedBy, 'Devv G');
  await S.sock.waitFor('device:state', (p) => p.pumpOn === true);

  r = await h.api('GET', `/devices/${S.deviceId}/commands/${r.body.commandId}`, { token: S.token });
  assert.equal(r.body.status, 'acked');

  r = await h.api('GET', `/devices/${S.deviceId}`, { token: S.token });
  assert.ok(r.body.openPumpRun);
  assert.equal(r.body.openPumpRun.startSource, 'app');

  // water rises, ESP auto cutoff stops the pump
  await S.dev.sendState({ cm: 60 });
  await h.sleep(1100);
  await S.dev.pub('event', { t: 'auto_cutoff', cm: 34.8 });
  S.dev.state.pump = 0;
  S.dev.state.cm = 34.8;
  await S.dev.sendState();
  const closed = await S.sock.waitFor('pump:run', (p) => !!p.run.endedAt);
  assert.equal(closed.run.stopReason, 'auto_cutoff');

  // full tank: ON refused by the backend
  r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.token, body: { action: 'on' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'TANK_FULL');

  // button press on the device
  await S.dev.sendState({ cm: 150 });
  await S.dev.pub('event', { t: 'pump', on: 1, src: 'button' });
  const btn = await S.sock.waitFor('pump:run', (p) => !p.run.endedAt && p.run.startSource === 'button');
  assert.ok(btn.run.id);
  r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.token, body: { action: 'off' } });
  assert.equal(r.status, 202);
  const off = await S.sock.waitFor('pump:run', (p) => !!p.run.endedAt && p.run.id === btn.run.id);
  assert.equal(off.run.stopReason, 'app');
  assert.equal(off.run.stoppedBy, 'Devv G');

  r = await h.api('GET', `/devices/${S.deviceId}/pump-runs?limit=1`, { token: S.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.ok(r.body.nextCursor);
  const r2 = await h.api('GET', `/devices/${S.deviceId}/pump-runs?limit=5&cursor=${r.body.nextCursor}`, { token: S.token });
  assert.equal(r2.body.items.length, 1);
  assert.equal(r2.body.items[0].stopReason, 'auto_cutoff');

  for (const period of ['day', 'week', 'month']) {
    r = await h.api('GET', `/devices/${S.deviceId}/pump-runs/summary?period=${period}`, { token: S.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.buckets.length, { day: 24, week: 7, month: 30 }[period]);
    assert.equal(r.body.runs, 2);
    // two runs of a few seconds each, empty buckets count 0
    assert.ok(r.body.totalS >= 0 && r.body.totalS < 120, `totalS ${r.body.totalS}`);
    assert.ok(r.body.buckets.filter((x) => x.runs === 0).every((x) => x.totalS === 0));
  }

  r = await h.api('GET', `/devices/${S.deviceId}/events`, { token: S.token });
  assert.ok(r.body.items.some((e) => e.type === 'auto_cutoff'));
  assert.ok(r.body.items.some((e) => e.type === 'settings_applied'));
  assert.ok(r.body.items.some((e) => e.type === 'claimed'));
});

test('5b. device refuses ON (near) -> command failed', async () => {
  // backend thinks the tank is not full, but the ESP says it is
  S.dev.settings = { cutoff_cm: 200 };
  const r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.token, body: { action: 'on' } });
  assert.equal(r.status, 202);
  const res = await S.sock.waitFor('command:result', (p) => p.commandId === r.body.commandId);
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'near');
  S.dev.settings = { cutoff_cm: 35 };
  const ev = await S.sock.waitFor('device:event', (p) => p.event.type === 'on_refused');
  assert.equal(ev.event.severity, 'warning');
});

// ---------------------------------------------------------------- 6. sharing
test('6. invite a view member, view cannot switch the pump; control can', async () => {
  let r = await h.api('POST', `/devices/${S.deviceId}/invites`, { token: S.token, body: { phone: S.userB.phone, permission: 'view' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.hasAccount, true);
  const inviteId = r.body.id;

  r = await h.api('POST', `/devices/${S.deviceId}/invites`, { token: S.userB.token, body: { phone: h.randomPhone(), permission: 'view' } });
  assert.equal(r.status, 403);

  r = await h.api('GET', '/invites', { token: S.userB.token });
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].deviceName, 'Home Tank');
  assert.equal(r.body.items[0].ownerName, 'Devv G');

  r = await h.api('POST', `/invites/${inviteId}/accept`, { token: S.userB.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.access, 'view');

  r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.userB.token, body: { action: 'on' } });
  assert.equal(r.status, 403);
  r = await h.api('PATCH', `/devices/${S.deviceId}/settings`, { token: S.userB.token, body: { cutoffCm: 40 } });
  assert.equal(r.status, 403);
  r = await h.api('GET', `/devices/${S.deviceId}`, { token: S.userB.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.access, 'view');

  r = await h.api('GET', `/devices/${S.deviceId}/members`, { token: S.token });
  assert.equal(r.body.members.length, 1);
  assert.equal(r.body.owner.id, S.userId);

  r = await h.api('PATCH', `/devices/${S.deviceId}/members/${S.userB.user.id}`, { token: S.token, body: { permission: 'control' } });
  assert.equal(r.status, 200);
  S.dev.settings = { cutoff_cm: 35 };
  r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.userB.token, body: { action: 'on' } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await S.sock.waitFor('command:result', (p) => p.commandId === r.body.commandId && p.status === 'acked');
  r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.userB.token, body: { action: 'off' } });
  await S.sock.waitFor('command:result', (p) => p.commandId === r.body.commandId && p.status === 'acked');

  // invite for a phone without an account, then cancel
  r = await h.api('POST', `/devices/${S.deviceId}/invites`, { token: S.token, body: { phone: h.randomPhone(), permission: 'view' } });
  assert.equal(r.body.hasAccount, false);
  const r3 = await h.api('DELETE', `/devices/${S.deviceId}/invites/${r.body.id}`, { token: S.token });
  assert.equal(r3.status, 204);

  // remove access: socket gets access:changed null
  S.sockB = await h.socket(S.userB.token);
  await S.sockB.emitWithAck('device:subscribe', { deviceIds: [S.deviceId] });
  r = await h.api('DELETE', `/devices/${S.deviceId}/members/${S.userB.user.id}`, { token: S.token });
  assert.equal(r.status, 204);
  const ch = await S.sockB.waitFor('access:changed', (p) => p.deviceId === S.deviceId);
  assert.equal(ch.access, null);
  r = await h.api('GET', `/devices/${S.deviceId}`, { token: S.userB.token });
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------- 7. timers, alerts, notifications
test('7a. timers CRUD + scheduler start/stop', async () => {
  let r = await h.api('POST', `/devices/${S.deviceId}/timers`, { token: S.token, body: { startTime: '06:00', stopTime: '06:00', days: ['mon'] } });
  assert.equal(r.status, 422);
  r = await h.api('POST', `/devices/${S.deviceId}/timers`, { token: S.token, body: { name: 'Night', startTime: '23:30', stopTime: '00:15', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], enabled: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.endsNextDay, true);
  assert.ok(r.body.nextRunAt);
  S.timerId = r.body.id;
  r = await h.api('PATCH', `/devices/${S.deviceId}/timers/${S.timerId}`, { token: S.token, body: { onlyIfBelowPct: 50 } });
  assert.equal(r.body.onlyIfBelowPct, 50);
  r = await h.api('GET', `/devices/${S.deviceId}/timers`, { token: S.token });
  assert.equal(r.body.items.length, 1);

  // tank at 150 cm -> (180-150)/(180-35) = 21% < 50%: the 23:30 start fires (simulated clock)
  await S.dev.sendState({ cm: 150, pump: 0 });
  await h.sleep(300);
  r = await h.api('POST', '/dev/jobs/timers', { body: { at: '2026-11-02T18:00:10Z' } }); // 23:30 IST
  assert.equal(r.status, 200);
  const cmd = await S.dev.waitFor('cmd', (p) => p.c === 'pump_on');
  assert.ok(cmd.id);
  const run = await S.sock.waitFor('pump:run', (p) => !p.run.endedAt && p.run.startSource === 'timer');
  assert.equal(run.run.timerName, 'Night');

  // 00:15 IST next day: stop
  await h.api('POST', '/dev/jobs/timers', { body: { at: '2026-11-02T18:45:10Z' } });
  await S.dev.waitFor('cmd', (p) => p.c === 'pump_off');
  const closed = await S.sock.waitFor('pump:run', (p) => !!p.run.endedAt && p.run.id === run.run.id);
  assert.equal(closed.run.stopReason, 'timer');

  // level above 50%: start skipped with a reason
  await S.dev.sendState({ cm: 60 });
  await h.sleep(300);
  await h.api('POST', '/dev/jobs/timers', { body: { at: '2026-11-03T18:00:10Z' } });
  r = await h.api('GET', `/devices/${S.deviceId}/timers`, { token: S.token });
  assert.match(r.body.items[0].lastSkipReason, /^level_\d+$/);

  r = await h.api('DELETE', `/devices/${S.deviceId}/timers/${S.timerId}`, { token: S.token });
  assert.equal(r.status, 204);
});

test('7b. alerts: settings, tank full notification, sensor fault, offline', async () => {
  let r = await h.api('GET', `/devices/${S.deviceId}/alerts`, { token: S.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 6);
  assert.equal(r.body.find((a) => a.type === 'tank_full').threshold, 95);

  r = await h.api('PUT', `/devices/${S.deviceId}/alerts`, {
    token: S.token,
    body: [{ type: 'tank_full', enabled: true, threshold: 90 }, { type: 'device_offline', enabled: true, threshold: 1 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.find((a) => a.type === 'tank_full').threshold, 90);

  // cross 90%: distance for 90% = 180 - 0.9*145 = 49.5
  await S.dev.sendState({ cm: 100 });
  await h.sleep(1100);
  await S.dev.sendState({ cm: 45 });
  const n = await S.sock.waitFor('notification', (p) => p.notification.type === 'tank_full');
  assert.match(n.notification.title, /Home Tank is full/);

  // sensor fault
  await S.dev.sendState({ st: 'FAULT' });
  const f = await S.sock.waitFor('notification', (p) => p.notification.type === 'sensor_fault');
  assert.ok(f.notification.body);
  r = await h.api('GET', '/admin/events?severity=critical&open=true', { token: S.admin });
  assert.ok(r.body.items.some((e) => e.deviceId === S.deviceId && e.type === 'sender_fault'));
  // ON refused while FAULT and auto mode
  r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.token, body: { action: 'on' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'SENSOR_FAULT');
  await S.dev.sendState({ st: 'WORK' });
  await h.until(async () => {
    const x = await h.api('GET', '/admin/events?severity=critical&open=true', { token: S.admin });
    return !x.body.items.some((e) => e.deviceId === S.deviceId && e.type === 'sender_fault');
  });

  r = await h.api('GET', '/notifications', { token: S.token });
  assert.ok(r.body.unread >= 2);
  r = await h.api('POST', '/notifications/read', { token: S.token, body: { all: true } });
  assert.equal(r.status, 204);
  r = await h.api('GET', '/notifications?unread=true', { token: S.token });
  assert.equal(r.body.unread, 0);
  assert.equal(r.body.items.length, 0);
});

test('7c. last will -> offline, reconnect -> online', async () => {
  S.dev.kill();
  const off = await S.sock.waitFor('device:online', (p) => p.deviceId === S.deviceId && p.online === false, 10000);
  assert.ok(off.at);
  let r = await h.api('POST', `/devices/${S.deviceId}/pump`, { token: S.token, body: { action: 'on' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DEVICE_OFFLINE');

  // settings changed while offline are queued and delivered (retained) on reconnect
  r = await h.api('PATCH', `/devices/${S.deviceId}/settings`, { token: S.token, body: { cutoffCm: 30 } });
  assert.equal(r.body.sync, 'queued_offline');
  const v = r.body.settings.version;

  // offline alert after the 1 minute threshold (job run with the clock as is: set offline_since back)
  const c = await h.db();
  await c.query(`UPDATE device_state SET offline_since = now() - interval '2 minutes' WHERE device_id = $1`, [S.deviceId]);
  await c.end();
  await h.api('POST', '/dev/jobs/offline-alerts');
  const n = await S.sock.waitFor('notification', (p) => p.notification.type === 'device_offline');
  assert.match(n.notification.title, /offline/);

  S.dev = new h.FakeDevice(S.macMain);
  await S.dev.connect();
  const set = await S.dev.waitFor('settings/set', (p) => p.v === v);
  assert.equal(set.cutoff_cm, 30);
  await S.sock.waitFor('device:online', (p) => p.deviceId === S.deviceId && p.online === true);
  await S.sock.waitFor('settings:sync', (p) => p.version === v && p.sync === 'applied');
  await S.dev.sendState({ cm: 100, pump: 0 });
});

// ---------------------------------------------------------------- admin: users, OTA, audit
test('8. admin users: block, unblock, password reset', async () => {
  let r = await h.api('GET', `/admin/users?q=${encodeURIComponent('Devv G')}`, { token: S.admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((u) => u.id === S.userId && u.devicesOwned === 1));

  r = await h.api('GET', `/admin/users/${S.userId}`, { token: S.admin });
  assert.equal(r.body.ownedDevices.length, 1);

  r = await h.api('POST', `/admin/users/${S.userId}/block`, { token: S.admin, body: { reason: 'test' } });
  assert.equal(r.status, 204);
  r = await h.api('GET', '/me', { token: S.token });
  assert.equal(r.status, 403); // blocked: every call says USER_BLOCKED
  assert.equal(r.body.error.code, 'USER_BLOCKED');
  r = await h.api('POST', '/auth/login', { body: { phone: S.phone, password: 'secret456' } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'USER_BLOCKED');
  r = await h.api('POST', `/admin/users/${S.userId}/unblock`, { token: S.admin });
  assert.equal(r.status, 204);

  r = await h.api('POST', `/admin/users/${S.userId}/password`, { token: S.admin, body: { newPassword: 'reset1234' } });
  assert.equal(r.status, 204);
  r = await h.api('POST', '/auth/login', { body: { phone: S.phone, password: 'reset1234' } });
  assert.equal(r.status, 200);
  S.token = r.body.accessToken;

  const me = (await h.api('GET', '/me', { token: S.admin })).body;
  r = await h.api('PATCH', `/admin/users/${me.id}`, { token: S.admin, body: { role: 'user' } });
  assert.equal(r.status, 409);
});

test('9. firmware upload, OTA rollout, device reports success', async () => {
  const bin = Buffer.alloc(4096, 0);
  bin[0] = 0xe9;
  const version = `9.${Math.floor(Math.random() * 100000)}`;
  const form = new FormData();
  form.set('version', version);
  form.set('board', 'main');
  form.set('notes', 'test build');
  form.set('file', new Blob([bin]), 'main_relay.bin');
  let r = await h.api('POST', '/admin/firmware', { token: S.admin, form });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rel = r.body;
  assert.equal(rel.fileSize, 4096);
  assert.equal(rel.sha256.length, 64);

  r = await h.api('PATCH', `/admin/firmware/${rel.id}`, { token: S.admin, body: { isStable: true } });
  assert.equal(r.body.isStable, true);
  const vj = await h.api('GET', `${h.BASE}/ota/version.json`);
  assert.equal(vj.body.version, version);
  const legacy = await h.api('GET', vj.body.url.replace(/^https?:\/\/[^/]+/, h.BASE), { raw: true });
  assert.equal(legacy.status, 200);

  S.sockAdmin = await h.socket(S.admin);
  r = await h.api('POST', '/admin/ota/rollouts', { token: S.admin, body: { releaseId: rel.id, deviceIds: [S.deviceId] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.sentNow, 1);
  const rolloutId = r.body.rolloutId;
  const msg = await S.dev.waitFor('ota', (p) => p.rid === rolloutId);
  assert.equal(msg.ver, version);
  assert.equal(msg.sha256, rel.sha256);
  assert.equal(msg.size, 4096);

  // download with the signed link
  const dl = await h.api('GET', msg.url.replace(/^https?:\/\/[^/]+/, h.BASE), { raw: true });
  assert.equal(dl.status, 200);
  assert.equal((await dl.arrayBuffer()).byteLength, 4096);
  assert.ok(dl.headers.get('x-md5'));
  const bad = await h.api('GET', `${h.BASE}/fw/${rel.id}.bin?t=nope`, { raw: true });
  assert.equal(bad.status, 403);

  await S.dev.pub('ota/status', { rid: rolloutId, s: 'downloading' });
  await S.sockAdmin.waitFor('ota:progress', (p) => p.rolloutId === rolloutId && p.status === 'downloading');
  // after reboot the board reports the new fw in its state
  await S.dev.sendState({ fw: version });
  await S.sockAdmin.waitFor('ota:progress', (p) => p.rolloutId === rolloutId && p.status === 'success');
  r = await h.api('GET', `/admin/ota/rollouts/${rolloutId}`, { token: S.admin });
  assert.equal(r.body.rollout.counts.success, 1);
  assert.equal(r.body.devices[0].fromVersion, '1.3');

  r = await h.api('DELETE', `/admin/firmware/${rel.id}`, { token: S.admin });
  assert.equal(r.status, 409);
  r = await h.api('GET', '/admin/firmware', { token: S.admin });
  assert.ok(r.body.items.find((x) => x.id === rel.id).devicesOnIt >= 1);
});

test('10. admin device actions + stats + audit', async () => {
  let r = await h.api('GET', '/admin/stats', { token: S.admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.totalDevices >= 2);
  assert.ok(r.body.onlineDevices >= 1);
  assert.ok(Array.isArray(r.body.fwVersions));

  r = await h.api('POST', `/admin/devices/${S.deviceId}/commands`, { token: S.admin, body: { type: 'reboot' } });
  assert.equal(r.status, 202);
  const cmd = await S.dev.waitFor('cmd', (p) => p.c === 'reboot');
  assert.equal(cmd.id, r.body.commandId);

  r = await h.api('PATCH', `/admin/devices/${S.deviceId}/settings`, { token: S.admin, body: { autoMode: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.autoMode, false);

  r = await h.api('POST', `/admin/devices/${S.deviceId}/claim-code`, { token: S.admin });
  assert.match(r.body.claimCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  r = await h.api('POST', `/admin/devices/${S.deviceId}/boards`, { token: S.admin, body: { role: 'sender', mac: h.randomMac() } });
  assert.equal(r.status, 201);

  // transfer to user B, then unclaim
  r = await h.api('POST', `/admin/devices/${S.deviceId}/transfer`, { token: S.admin, body: { toPhone: S.userB.phone } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await h.api('GET', `/devices/${S.deviceId}`, { token: S.userB.token });
  assert.equal(r.body.access, 'owner');
  r = await h.api('GET', `/devices/${S.deviceId}`, { token: S.token });
  assert.equal(r.status, 403);

  r = await h.api('POST', `/admin/devices/${S.deviceId}/unclaim`, { token: S.admin, body: { reason: 'test' } });
  assert.equal(r.status, 204);
  r = await h.api('DELETE', `/admin/devices/${S.deviceId}`, { token: S.admin });
  assert.equal(r.status, 409); // was claimed before

  // disable device 2 -> MQTT login refused
  r = await h.api('PATCH', `/admin/devices/${S.device2Id}`, { token: S.admin, body: { isDisabled: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.isDisabled, true);
  await S.dev2.close();
  S.dev2 = null;
  await h.sleep(2500); // Mosquitto caches logins for 2 s
  const mac2 = (await h.api('GET', `/admin/devices/${S.device2Id}`, { token: S.admin })).body.boards.find((b) => b.role === 'main').mac;
  await assert.rejects(new h.FakeDevice(mac2).connect(), /Not authorized/);

  r = await h.api('GET', '/admin/audit?action=device.', { token: S.admin });
  assert.ok(r.body.items.some((a) => a.action === 'device.transfer'));
  assert.ok(r.body.items.some((a) => a.action === 'device.register'));

  r = await h.api('POST', '/admin/devices/bulk', { token: S.admin, body: { rows: [{ macMain: h.randomMac(), macSender: h.randomMac() }, { macMain: 'bad', macSender: 'bad' }] } });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, 1);
  assert.equal(r.body.failed, 1);
  assert.match(r.body.stickerSheetHtml, /<img/);
});

test('11. delete account releases owned devices', async () => {
  const u = await h.registerAndLogin('Temp');
  const reg = await h.api('POST', '/admin/devices', { token: S.admin, body: { macMain: h.randomMac(), macSender: h.randomMac() } });
  let r = await h.api('POST', '/devices/claim', { token: u.token, body: { serial: reg.body.serial, claimCode: reg.body.claimCode, name: 'Temp tank' } });
  assert.equal(r.status, 201);
  r = await h.api('DELETE', '/me', { token: u.token, body: { password: 'wrong' } });
  assert.equal(r.status, 422);
  r = await h.api('DELETE', '/me', { token: u.token, body: { password: 'secret123' } });
  assert.equal(r.status, 204);
  r = await h.api('GET', `/admin/devices/${reg.body.device.id}`, { token: S.admin });
  assert.equal(r.body.owner, null);
  // phone is free again
  r = await h.api('POST', '/auth/register', { body: { fullName: 'Again', phone: u.phone, password: 'secret123' } });
  assert.equal(r.status, 201);
});
