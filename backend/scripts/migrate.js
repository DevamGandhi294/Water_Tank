// Applies database/migrations/*.sql in filename order.
// Applied files are recorded in schema_migrations, so each runs only once.
// Usage: npm run migrate          (apply pending)
//        npm run migrate:status   (list applied / pending)
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { Client } = require('pg');

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.resolve(__dirname, '../../database/migrations');

async function main() {
  const statusOnly = process.argv.includes('--status');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) {
        if (statusOnly) console.log(`applied  ${file}`);
        continue;
      }
      if (statusOnly) { console.log(`pending  ${file}`); continue; }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`applying ${file} ...`);
      // Migration files may contain their own BEGIN/COMMIT. The bookkeeping
      // insert runs right after; if the file fails, nothing is recorded.
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      console.log(`applied  ${file}`);
    }
    if (!statusOnly) console.log('Migrations up to date.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
