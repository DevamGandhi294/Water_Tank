const db = require('../db');

// Every admin write goes through here. Never put secrets in data.
async function audit(req, action, targetType, targetId, data, client = db) {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user ? req.user.id : null, action, targetType, targetId == null ? null : String(targetId),
      data ? JSON.stringify(data) : null, req.ip || null],
  );
}

module.exports = { audit };
