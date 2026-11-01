#!/bin/sh
# Nightly Postgres backup, keeps 14 days. Install with cron (DEPLOY.md step 10):
#   15 3 * * * /opt/watertank/deploy/backup.sh >> /var/log/watertank-backup.log 2>&1
set -e
APP_DIR=/opt/watertank
OUT=/var/backups/watertank
mkdir -p "$OUT"
cd "$APP_DIR"
. ./.env
STAMP=$(date +%Y%m%d-%H%M)
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$OUT/watertank-$STAMP.dump"
# firmware files uploaded from the admin panel
docker compose -f docker-compose.prod.yml exec -T backend tar -C /srv -cf - ota > "$OUT/ota-$STAMP.tar"
find "$OUT" -type f -mtime +14 -delete
echo "$(date) backup ok: $OUT/watertank-$STAMP.dump"
