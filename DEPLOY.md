# Deploying to the Contabo VPS

Target: **watertank.ecobridgers.com** on the Contabo VPS **94.136.187.14** (Ubuntu 22.04/24.04), next to **magicoutline.ecobridgers.com**, which already runs on the same server.

How it fits together:

```
Internet ──443──► web server already on the VPS (Nginx, also serves magicoutline)
                    └─ watertank.ecobridgers.com ──► 127.0.0.1:8088  (web container: admin panel + /api + /socket.io + /fw + /ota)
                                                         └─► backend :3000 ─► postgres, mosquitto
Internet ──8883 (MQTT TLS)──► mosquitto container  (ESP boards)
```

The Water Tank stack never binds ports 80 or 443, so magicoutline keeps working exactly as it is. It adds one new Nginx server block for `watertank.ecobridgers.com`, and opens port 8883 for the boards.

Every command below runs on the VPS over SSH unless it says otherwise. Replace nothing except where it says `<...>`.

---

## 1. Look at what is already running

```bash
ssh root@94.136.187.14
sudo ss -tlnp | grep -E ':(80|443|8088|8883|1883)\s'
ls /etc/nginx/sites-enabled/ 2>/dev/null
docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null
```

* If **nginx** (a host process) owns 80/443 → follow this guide as written (case A, most likely: the old OTA files are in `/var/www/watertank/`).
* If a **Docker container** (Traefik, nginx-proxy, Caddy…) owns 80/443 → do steps 2–5 and 8–11, and in step 6 point that proxy at `http://127.0.0.1:8088` for `watertank.ecobridgers.com` instead (case B, see the end).
* Nothing should be on 8088, 8883 or 1883. If 8088 is taken, set another `WEB_PORT` in step 4 and use it in step 6.

Check DNS from your PC: `nslookup watertank.ecobridgers.com` must answer `94.136.187.14` (it already does).

## 2. Install Docker (skip if `docker compose version` works)

```bash
curl -fsSL https://get.docker.com | sh
docker compose version
```

## 3. Get the code

```bash
sudo mkdir -p /opt/watertank && sudo chown $USER /opt/watertank
git clone https://github.com/DevamGandhi294/Water_Tank.git /opt/watertank
cd /opt/watertank
```

## 4. Create `.env`

```bash
cp .env.example .env
nano .env
```

Fill in at least these (make each secret with `openssl rand -hex 32`, a different one each time):

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | random |
| `JWT_SECRET` | random |
| `HASH_PEPPER` | random. **Never change it later**: printed claim codes depend on it. |
| `MQTT_BACKEND_PASSWORD` | random |
| `PUBLIC_BASE_URL` | `https://watertank.ecobridgers.com` (already set) |
| `CORS_ORIGINS` | `https://watertank.ecobridgers.com` (already set) |
| `SMS_PROVIDER` | `none` for now |

Leave `DATABASE_URL`, `POSTGRES_HOST`, `POSTGRES_PORT` as they are (only used on the dev machine). Then:

```bash
chmod 600 .env
```

## 5. Start the stack

Mosquitto needs a certificate file before it can start its TLS port, so start everything except Mosquitto first:

```bash
docker compose -f docker-compose.prod.yml up -d --build postgres backend web
docker compose -f docker-compose.prod.yml ps
curl -s http://127.0.0.1:8088/health
```

`/health` shows `"db":true` and `"mqtt":false` (Mosquitto is not running yet, that's expected). The backend applies the database migrations by itself on every start.

## 6. Nginx server block + HTTPS (case A)

```bash
sudo cp deploy/nginx/host-watertank.conf /etc/nginx/sites-available/watertank.ecobridgers.com
```

If an older `watertank.ecobridgers.com` server block already exists (the one serving `/var/www/watertank/ota`), disable it first so there is only one:

```bash
grep -l "watertank.ecobridgers.com" /etc/nginx/sites-enabled/*
sudo rm /etc/nginx/sites-enabled/<old-file-from-the-line-above>   # only if it's not the new one
```

Then enable the new one and get the certificate:

```bash
sudo ln -s /etc/nginx/sites-available/watertank.ecobridgers.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx     # skip if certbot is installed
sudo certbot --nginx -d watertank.ecobridgers.com --redirect -m <your-email> --agree-tos -n
```

Certbot adds the `listen 443 ssl` lines to that one file. magicoutline's file is not touched.

Check from your PC: open `https://watertank.ecobridgers.com/health`.

## 7. Certificate for Mosquitto + start it

Copy the certificate for the broker and let certbot do it again after every renewal:

```bash
sudo cp deploy/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/watertank-mosquitto.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/watertank-mosquitto.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/watertank-mosquitto.sh      # copies the cert now (restart error is fine the first time)
docker compose -f docker-compose.prod.yml up -d mosquitto
docker compose -f docker-compose.prod.yml logs mosquitto --tail 20
curl -s http://127.0.0.1:8088/health          # now "mqtt":true
```

The hook script assumes the code is in `/opt/watertank`. Edit `APP_DIR` in it if you put it elsewhere.

## 8. Firewall

```bash
sudo ufw status
sudo ufw allow 8883/tcp comment 'Water Tank MQTT TLS'
```

If ufw is inactive, also check the Contabo panel firewall (if you use one) and allow TCP 8883. Do **not** open 1883, 3000, 5432 or 8088: they are only for the server itself.

Check from your PC (needs `mosquitto-clients`):
```bash
mosquitto_sub -h watertank.ecobridgers.com -p 8883 --capath /etc/ssl/certs -u test -P x -i test -t x
# "Connection Refused: not authorised" = TLS and the broker work (test is not a registered MAC)
```

## 9. Create your admin account

```bash
docker compose -f docker-compose.prod.yml exec backend npm run create-admin -- \
  --phone +91<your-number> --name "Devv" --password '<a-strong-password>'
```

Log in at **https://watertank.ecobridgers.com** with that phone number and password. Running the command again for the same number resets that admin's password.

## 10. Backups

```bash
sudo crontab -e
# add this line:
15 3 * * * /opt/watertank/deploy/backup.sh >> /var/log/watertank-backup.log 2>&1
```

Backups go to `/var/backups/watertank/` (database dump + uploaded firmware files, 14 days). Copy them off the server now and then. Restore a dump:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U waterlevel -d waterlevel --clean --if-exists < /var/backups/watertank/watertank-<stamp>.dump
```

## 11. Keep the old boards updating

Boards on firmware 1.2 / 1.3 still read `https://watertank.ecobridgers.com/ota/version.json`. That URL now comes from the backend. In the admin panel → **Firmware & OTA**, upload the current `main_relay_1.3.bin` as version `1.3`, board Main, and click **Mark stable**. From then on, marking a newer release stable is how you update those boards. The files in `/var/www/watertank/ota/` are no longer used and can be archived.

---

## Updating to a new version

```bash
cd /opt/watertank
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

Migrations run automatically when the backend restarts. Your data stays in the Docker volumes `watertank_pgdata`, `watertank_ota_files` and `watertank_mosquitto_data`.

## Useful commands

```bash
docker compose -f docker-compose.prod.yml logs -f backend          # API + MQTT log
docker compose -f docker-compose.prod.yml logs -f mosquitto        # device logins
docker compose -f docker-compose.prod.yml exec postgres psql -U waterlevel -d waterlevel
docker compose -f docker-compose.prod.yml restart backend
# watch all device traffic (backend login from .env)
docker compose -f docker-compose.prod.yml exec mosquitto mosquitto_sub -h 127.0.0.1 -u wt-backend -P "$(grep ^MQTT_BACKEND_PASSWORD .env | cut -d= -f2)" -t 'wt/#' -v
```

## Push notifications (later)

1. Create a Firebase project, add the Android app (`com.ecobridgers.water_tank`) and download `google-services.json` for the app build (see `mobile/README.md`).
2. Firebase console → Project settings → Service accounts → Generate new private key. Save it on the server as `/opt/watertank/deploy/secrets/fcm-service-account.json`.
3. In `.env`: `FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm-service-account.json`, then `docker compose -f docker-compose.prod.yml up -d backend`.

Until then, alerts are stored and shown in the app's Alerts tab, but not pushed.

## SMS (later)

Set `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID` (template with an `##otp##` variable) and optionally `MSG91_INVITE_TEMPLATE_ID`, then restart the backend. Sign-up then asks for a code, and "Forgot password" works by SMS. Until then the admin resets passwords from the Users page.

## Case B: a Docker reverse proxy owns 80/443

Skip the host Nginx steps in 6. Add `watertank.ecobridgers.com` to that proxy with target `http://127.0.0.1:8088` (or put the `web` service on the proxy's Docker network and target `web:80`), with WebSocket support on. Let that proxy get the certificate. For Mosquitto, copy that proxy's certificate and key for the domain to `/opt/watertank/deploy/certs/mosquitto/fullchain.pem` and `privkey.pem` (owner 1000, key mode 600) and restart Mosquitto after each renewal, or run `certbot certonly --webroot` just for the broker.

## Troubleshooting

| Problem | Check |
|---|---|
| `502 Bad Gateway` on the site | `docker compose -f docker-compose.prod.yml ps`, is `web` up? `curl 127.0.0.1:8088/health` |
| Admin panel loads but login fails with a network error | `CORS_ORIGINS` must be exactly `https://watertank.ecobridgers.com` |
| Live updates don't arrive | the host Nginx block must pass `Upgrade` / `Connection` headers (it does if you used the file from `deploy/nginx`) |
| A board can't connect | Was its main MAC registered? Is it disabled? `docker compose ... logs mosquitto` shows `not authorised` for unknown MACs. Is 8883 open? |
| Mosquitto restarts in a loop | the cert files in `deploy/certs/mosquitto/` are missing; run the hook script from step 7 |
