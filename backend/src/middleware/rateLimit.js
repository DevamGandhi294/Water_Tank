// Tiny in-memory fixed-window limiter (one backend instance). Key = route + phone/user + ip.
const { E } = require('../errors');

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

const LIMIT_SCALE = Number(process.env.RATE_LIMIT_SCALE || 1); // tests may raise limits

function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit * LIMIT_SCALE;
}

// keyFn(req) -> string. failuresOnly: count only responses >= 400.
function limiter(name, { limit = 5, windowMs = 10 * 60_000, keyFn, failuresOnly = false } = {}) {
  return (req, res, next) => {
    const key = `${name}:${keyFn ? keyFn(req) : ''}:${req.ip}`;
    const b = buckets.get(key);
    if (b && b.resetAt > Date.now() && b.count >= limit * LIMIT_SCALE) return next(E.tooMany());
    if (!failuresOnly) {
      if (!hit(key, limit, windowMs)) return next(E.tooMany());
      return next();
    }
    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode !== 429) hit(key, limit, windowMs);
    });
    next();
  };
}

module.exports = { limiter, hit };
