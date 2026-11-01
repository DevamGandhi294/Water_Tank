// Create (or promote) the super admin.
// Usage: npm run create-admin -- --phone +919876543210 --name "Devv" --password 'secret123'
// In Docker: docker compose exec backend npm run create-admin -- --phone ... --name ... --password ...
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), quiet: true });

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const phone = arg('phone');
  const name = arg('name') || 'Admin';
  const password = arg('password');
  if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('--phone must be E.164, e.g. +919876543210');
  if (!password || password.length < 8) throw new Error('--password must be at least 8 characters');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const hash = await bcrypt.hash(password, 11);
    const r = await c.query(
      `INSERT INTO users (full_name, phone, password_hash, role, phone_verified_at)
       VALUES ($1,$2,$3,'super_admin', now())
       ON CONFLICT (phone) DO UPDATE SET role = 'super_admin', password_hash = EXCLUDED.password_hash,
         full_name = EXCLUDED.full_name, is_blocked = false, deleted_at = NULL,
         phone_verified_at = COALESCE(users.phone_verified_at, now()), token_version = users.token_version + 1
       RETURNING id`,
      [name, phone, hash],
    );
    console.log(`super_admin ready: ${phone} (${r.rows[0].id})`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
