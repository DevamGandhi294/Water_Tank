#!/bin/sh
# Container entrypoint: apply pending migrations, then start the API.
set -e
node scripts/migrate.js
exec node src/index.js
