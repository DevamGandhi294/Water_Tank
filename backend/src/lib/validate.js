const { z } = require('zod');
const { E } = require('../errors');

// Parse req.body (or any value) with a zod schema; first problem -> 400 VALIDATION
function parse(schema, value) {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue.path.join('.') || undefined;
  throw E.bad('VALIDATION', field ? `${field}: ${issue.message}` : issue.message, field);
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm');
const uuid = z.string().regex(/^[0-9a-f-]{36}$/i, 'must be a uuid');
const password = z.string().min(8, 'must be at least 8 characters').max(128);

module.exports = { z, parse, hhmm, uuid, password };
