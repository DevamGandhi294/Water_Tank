// DB rows -> API JSON (camelCase), shared by app and admin routes.
const { iso, macOut } = require('./format');

function user(u) {
  if (!u) return null;
  return {
    id: u.id,
    fullName: u.full_name,
    phone: u.phone,
    email: u.email,
    role: u.role,
    hasPassword: u.has_password !== undefined ? !!u.has_password : !!u.password_hash,
    googleLinked: !!u.google_sub,
    createdAt: iso(u.created_at),
  };
}

function stateCard(s) {
  return {
    online: !!(s && s.is_online),
    status: (s && s.status) || 'UNKNOWN',
    pumpOn: !!(s && s.pump_on),
    distanceCm: s ? s.distance_cm : null,
    levelPct: s ? s.level_pct : null,
    lastSeenAt: s ? iso(s.last_seen_at) : null,
  };
}

function settings(st, online) {
  if (!st) return null;
  let sync = 'applied';
  if (st.version > st.applied_version) sync = online ? 'sending' : 'queued_offline';
  return {
    cutoffCm: st.cutoff_distance_cm,
    tankHeightCm: st.tank_height_cm,
    capacityLitres: st.capacity_litres,
    autoMode: st.auto_mode,
    lowLevelPct: st.low_level_pct,
    fullLevelPct: st.full_level_pct,
    maxPumpMinutes: st.max_pump_minutes,
    version: st.version,
    appliedVersion: st.applied_version,
    appliedAt: iso(st.applied_at),
    sync,
  };
}

const board = (b) => ({ role: b.role, mac: macOut(b.mac), fwVersion: b.fw_version });

const event = (e) => ({
  id: e.id, type: e.type, severity: e.severity, message: e.message, data: e.data,
  occurredAt: iso(e.occurred_at), resolvedAt: iso(e.resolved_at),
});

module.exports = { user, stateCard, settings, board, event };
