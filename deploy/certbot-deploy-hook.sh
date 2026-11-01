#!/bin/sh
# Certbot runs this after every renewal of watertank.ecobridgers.com
# (install: DEPLOY.md step 7). Mosquitto runs as uid 1000 inside its container
# and cannot read /etc/letsencrypt, so the cert is copied next to the stack
# and the broker restarted. Also reloads the host Nginx.
set -e
DOMAIN=watertank.ecobridgers.com
APP_DIR=/opt/watertank
DEST="$APP_DIR/deploy/certs/mosquitto"

mkdir -p "$DEST"
cp -L "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$DEST/fullchain.pem"
cp -L "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$DEST/privkey.pem"
chown 1000:1000 "$DEST"/*.pem
chmod 600 "$DEST/privkey.pem"
chmod 644 "$DEST/fullchain.pem"

cd "$APP_DIR" && docker compose -f docker-compose.prod.yml restart mosquitto
systemctl reload nginx 2>/dev/null || true
