// PATCH settings (used by the owner route 4.2 and admin 10.14)
const db = require('../db');
const { E } = require('../errors');
const { z, parse } = require('../lib/validate');
const ser = require('../lib/serialize');
const settingsSync = require('./settingsSync');
const live = require('./live');

const schema = z.object({
  cutoffCm: z.number().finite().optional(),
  tankHeightCm: z.union([z.number().finite(), z.null()]).optional(),
  capacityLitres: z.union([z.number().int().positive().max(10_000_000), z.null()]).optional(),
  autoMode: z.boolean().optional(),
  lowLevelPct: z.number().int().min(0).max(100).optional(),
  fullLevelPct: z.number().int().min(0).max(100).optional(),
  maxPumpMinutes: z.union([z.number().int().min(1).max(1440), z.null()]).optional(),
});

const COLS = {
  cutoffCm: 'cutoff_distance_cm',
  tankHeightCm: 'tank_height_cm',
  capacityLitres: 'capacity_litres',
  autoMode: 'auto_mode',
  lowLevelPct: 'low_level_pct',
  fullLevelPct: 'full_level_pct',
  maxPumpMinutes: 'max_pump_minutes',
};
const KEY_OF_COL = Object.fromEntries(Object.entries(COLS).map(([k, v]) => [v, k]));

// Same rules as the DB checks, with error codes the app can show
function validate(cur, b) {
  const cutoff = b.cutoffCm ?? cur.cutoff_distance_cm;
  const height = b.tankHeightCm !== undefined ? b.tankHeightCm : cur.tank_height_cm;
  const low = b.lowLevelPct ?? cur.low_level_pct;
  const full = b.fullLevelPct ?? cur.full_level_pct;
  if (b.cutoffCm !== undefined) {
    if (b.cutoffCm < 25) throw E.invalid('CUTOFF_TOO_LOW', 'Cutoff must be at least 25 cm', 'cutoffCm');
    if (b.cutoffCm > 300) throw E.invalid('CUTOFF_TOO_HIGH', 'Cutoff can be at most 300 cm', 'cutoffCm');
  }
  if (b.tankHeightCm !== undefined && b.tankHeightCm !== null && (b.tankHeightCm < 30 || b.tankHeightCm > 1000)) {
    throw E.invalid('TANK_HEIGHT_INVALID', 'Tank height must be between 30 and 1000 cm', 'tankHeightCm');
  }
  if (height !== null && height !== undefined && cutoff >= height) {
    throw E.invalid('CUTOFF_OUTSIDE_TANK', 'Cutoff must be less than the tank height',
      b.cutoffCm !== undefined ? 'cutoffCm' : 'tankHeightCm');
  }
  if (low >= full) throw E.invalid('LEVELS_INVALID', 'Low alert level must be below the full level', 'lowLevelPct');
}

const round1 = (n) => (n === null || n === undefined ? n : Math.round(n * 10) / 10);

// Returns { settings, sync }
async function update(deviceId, body, userId) {
  const b = parse(schema, body);
  if (b.cutoffCm !== undefined) b.cutoffCm = round1(b.cutoffCm);
  if (b.tankHeightCm !== undefined) b.tankHeightCm = round1(b.tankHeightCm);
  const cur = await db.one('SELECT * FROM device_settings WHERE device_id = $1', [deviceId]);
  if (!cur) throw E.notFound('DEVICE_NOT_FOUND', 'Tank not found');
  validate(cur, b);

  const sets = [];
  const vals = [deviceId];
  for (const [k, col] of Object.entries(COLS)) {
    if (b[k] !== undefined) {
      vals.push(b[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) {
    const st = await live.stateFor(deviceId);
    return { settings: ser.settings(cur, st && st.is_online), sync: settingsSync.syncState(cur, st && st.is_online) };
  }
  vals.push(userId);
  const s = await db.one(
    `UPDATE device_settings SET ${sets.join(', ')}, updated_by = $${vals.length} WHERE device_id = $1 RETURNING *`,
    vals,
  ).catch((err) => {
    if (err.code === '23514') throw E.invalid('SETTINGS_INVALID', 'These settings are not allowed');
    throw err;
  });
  await live.settingsChanged(deviceId, s);
  let sync = settingsSync.syncState(s, (await live.stateFor(deviceId)).is_online);
  if (s.version > cur.version) sync = (await settingsSync.publish(deviceId)) || sync;
  const st = await live.stateFor(deviceId);
  return { settings: ser.settings(s, st && st.is_online), sync };
}

// settings_changes -> API (column names to camelCase)
function historyItem(r) {
  const rename = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [KEY_OF_COL[k] || k, v]));
  return {
    version: r.version,
    changedBy: r.changed_by_name || null,
    old: rename(r.old_values),
    new: rename(r.new_values),
    changedAt: r.changed_at ? new Date(r.changed_at).toISOString() : null,
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null,
  };
}

async function history(deviceId, limit = 50) {
  const rows = await db.many(
    `SELECT c.*, u.full_name AS changed_by_name FROM settings_changes c LEFT JOIN users u ON u.id = c.changed_by
      WHERE c.device_id = $1 ORDER BY c.version DESC LIMIT $2`,
    [deviceId, limit],
  );
  return rows.map(historyItem);
}

module.exports = { update, history, validate };
