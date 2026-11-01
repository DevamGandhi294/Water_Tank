// Timer helpers: days mask (bit 0 = Mon ... bit 6 = Sun), next run in the device time zone.
const { DateTime } = require('luxon');
const { iso } = require('./format');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const daysToMask = (days) => days.reduce((m, d) => m | (1 << DAYS.indexOf(d)), 0);
const maskToDays = (mask) => DAYS.filter((_d, i) => mask & (1 << i));
const hhmm = (t) => String(t).slice(0, 5); // "06:00:00" -> "06:00"
const endsNextDay = (start, stop) => hhmm(stop) < hhmm(start);

// luxon weekday: 1 = Mon ... 7 = Sun
const dayOn = (mask, luxonWeekday) => !!(mask & (1 << (luxonWeekday - 1)));

function nextRunAt(t, timezone, now = DateTime.now()) {
  if (!t.is_enabled) return null;
  const local = now.setZone(timezone || 'Asia/Kolkata');
  const [h, m] = hhmm(t.start_time).split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const day = local.plus({ days: i }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (day > local && dayOn(t.days_mask, day.weekday)) return day.toUTC().toISO();
  }
  return null;
}

function serialize(t, timezone) {
  return {
    id: t.id,
    name: t.name,
    startTime: hhmm(t.start_time),
    stopTime: hhmm(t.stop_time),
    days: maskToDays(t.days_mask),
    onlyIfBelowPct: t.only_if_below_pct,
    enabled: t.is_enabled,
    endsNextDay: endsNextDay(t.start_time, t.stop_time),
    nextRunAt: nextRunAt(t, timezone),
    lastStartedAt: iso(t.last_started_at),
    lastStoppedAt: iso(t.last_stopped_at),
    lastSkippedAt: iso(t.last_skipped_at),
    lastSkipReason: t.last_skip_reason || null,
  };
}

module.exports = { DAYS, daysToMask, maskToDays, nextRunAt, serialize, dayOn, endsNextDay, hhmm };
