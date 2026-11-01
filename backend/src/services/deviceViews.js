// deviceCard / deviceDetail builders (API.md section 3)
const db = require('../db');
const live = require('./live');
const pumpRuns = require('./pumpRuns');
const ser = require('../lib/serialize');
const { iso } = require('../lib/format');

function card(d, access, state) {
  return {
    id: d.id,
    serial: d.serial_no,
    name: d.name,
    location: d.location,
    access,
    isDisabled: d.is_disabled,
    state: ser.stateCard(state),
  };
}

async function cardFor(deviceId, access) {
  const d = await db.one('SELECT * FROM devices WHERE id = $1', [deviceId]);
  if (!d) return null;
  return card(d, access, await live.stateFor(deviceId));
}

// all tanks a user owns or was given (no paging; a user has few tanks)
async function listForUser(userId) {
  const rows = await db.many(
    `SELECT d.*, da.access FROM device_access da JOIN devices d ON d.id = da.device_id
      WHERE da.user_id = $1 ORDER BY (da.access = 'owner') DESC, d.claimed_at, d.created_at`,
    [userId],
  );
  const out = [];
  for (const d of rows) out.push(card(d, d.access, await live.stateFor(d.id)));
  return out;
}

async function detail(deviceId, access) {
  const d = await db.one('SELECT * FROM devices WHERE id = $1', [deviceId]);
  if (!d) return null;
  const [boards, settings, state] = await Promise.all([
    db.many(`SELECT * FROM device_boards WHERE device_id = $1 AND replaced_at IS NULL ORDER BY role`, [deviceId]),
    db.one('SELECT * FROM device_settings WHERE device_id = $1', [deviceId]),
    live.stateFor(deviceId),
  ]);
  const c = card(d, access, state);
  return {
    ...c,
    timezone: d.timezone,
    hwModel: d.hw_model,
    claimedAt: iso(d.claimed_at),
    boards: boards.map(ser.board),
    settings: ser.settings(settings, state && state.is_online),
    state: {
      ...c.state,
      wifiRssi: state ? state.wifi_rssi : null,
      uptimeS: state ? state.uptime_s : null,
      fwVersion: state ? state.fw_version : null,
      senderOk: state ? state.sender_ok : null,
      onlineSince: state ? iso(state.online_since) : null,
      offlineSince: state ? iso(state.offline_since) : null,
    },
    openPumpRun: await pumpRuns.openRun(deviceId),
  };
}

module.exports = { card, cardFor, listForUser, detail };
