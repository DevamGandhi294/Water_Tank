// Small helpers shared by routes: phone, MAC, cursor, level %, versions.
const { E } = require('../errors');

// E.164. Accepts "+91 98765 43210", "+91-98765-43210" and a bare 10 digit Indian number.
function normalizePhone(input, field = 'phone') {
  if (typeof input !== 'string') throw E.bad('INVALID_PHONE', 'Phone number is required', field);
  let p = input.replace(/[\s\-().]/g, '');
  if (/^[6-9]\d{9}$/.test(p)) p = `+91${p}`;
  if (/^00\d+$/.test(p)) p = `+${p.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(p)) {
    throw E.bad('INVALID_PHONE', 'Phone must look like +919876543210', field);
  }
  return p;
}

// "a4:cf:12:9b:3e:01", "A4-CF-12-9B-3E-01", "a4cf129b3e01" -> "A4:CF:12:9B:3E:01"
function normalizeMac(input, field = 'mac') {
  const hex = String(input || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12 || /[^0-9A-F]/.test(hex) || !/^[0-9A-Fa-f:\-.\s]+$/.test(String(input || ''))) {
    throw E.bad('INVALID_MAC', 'MAC must look like A4:CF:12:9B:42:10', field);
  }
  return hex.match(/.{2}/g).join(':');
}
const macToUsername = (mac) => mac.replace(/:/g, '').toLowerCase();
const macOut = (mac) => (mac ? String(mac).toUpperCase() : null);

// Opaque cursor for keyset paging: base64url(JSON)
const encodeCursor = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function decodeCursor(c) {
  if (!c) return null;
  try {
    return JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8'));
  } catch {
    throw E.bad('INVALID_CURSOR', 'Invalid cursor', 'cursor');
  }
}
function pageLimit(v, def = 20, max = 100) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// pct = (tankHeight - distance) / (tankHeight - cutoff) * 100, clamped 0..100
function levelPct(distanceCm, tankHeightCm, cutoffCm) {
  if (distanceCm === null || distanceCm === undefined || !tankHeightCm) return null;
  const span = tankHeightCm - cutoffCm;
  if (span <= 0) return null;
  const p = Math.round(((tankHeightCm - distanceCm) / span) * 100);
  return Math.max(0, Math.min(100, p));
}

// "1.10" > "1.9"
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

module.exports = {
  normalizePhone, normalizeMac, macToUsername, macOut, encodeCursor, decodeCursor,
  pageLimit, levelPct, compareVersions, iso,
};
