# Water Tank platform

IoT water tank monitoring and pump control: ESP8266 boards report the level over MQTT, the backend stores state and history in PostgreSQL, and customers use a Flutter app while support uses a web admin panel. Replaces the old Firebase setup.

```
ESP main board ──MQTT/TLS──► Mosquitto ◄──► backend (Node.js) ──Socket.IO / REST──► Flutter app, admin panel
                                              │
                                          PostgreSQL
```

| Folder | What |
|---|---|
| `backend/` | Node.js 22 + Express 5 API, JWT auth, Socket.IO, MQTT bridge, scheduler (timers, alerts, OTA) |
| `admin-panel/` | React + Vite admin panel (light theme): devices, registration + QR stickers, users, firmware/OTA, audit |
| `mobile/` | Flutter app (Android + iOS, light theme): tanks, live level, pump, cutoff, timers, sharing, history, alerts |
| `database/` | `schema.sql`, `DESIGN.md`, numbered `migrations/` |
| `deploy/` | production configs: Mosquitto TLS, Nginx, certbot hook, backups |
| `docs/` | [`API.md`](docs/API.md) (REST + Socket.IO), [`DEVICE-API.md`](docs/DEVICE-API.md) (firmware MQTT/OTA), `ui-mockup.html` |
| `DEPLOY.md` | step-by-step production setup on the Contabo VPS |

Decisions so far: phone + password login (no SMS yet, admin resets passwords), no Google sign-in yet, devices log in to MQTT by their registered main board MAC, light theme only. **Later:** a public Next.js website for the product (not started), SMS OTP with MSG91, Google sign-in, FCM push setup, level history graphs (`level_hourly`, see `database/DESIGN.md`).

## Local development (WSL + Docker)

Everything runs in Docker; nothing is needed on Windows.

```bash
cp .env.example .env            # dev: set POSTGRES_PASSWORD and DATABASE_URL to match; the rest can stay
docker compose up -d --build    # postgres :5433, mosquitto :1883, backend :3000, pgadmin :5050
docker compose logs -f backend
```

The backend container applies migrations on start and reloads when files in `backend/src` change. Create your admin:

```bash
docker compose exec backend npm run create-admin -- --phone +919876543210 --name "Devv" --password 'secret123'
```

| Service | Address |
|---|---|
| API | http://localhost:3000/api/v1 (health: http://localhost:3000/health) |
| Admin panel (dev) | `cd admin-panel && npm install && npm run dev` → http://localhost:5173 (proxies the API) |
| MQTT | `localhost:1883` (devices: registered MAC as username and client id) |
| PostgreSQL | `localhost:5433`, or `docker compose exec postgres psql -U waterlevel -d waterlevel` |
| pgAdmin | http://localhost:5050 (server "waterlevel (docker)" is pre-added; host inside Docker is `postgres:5432`) |

PostgreSQL uses host port 5433 because 5432 is taken by another project on this machine.

### Try it without hardware

Register a device in the admin panel (any MAC pair, e.g. `A4:CF:12:9B:42:10` / `84:F3:EB:20:14:5B`), then run a simulated board:

```bash
cd backend && npm install
npm run fake-device -- A4:CF:12:9B:42:10
```

Claim it in the app with the serial + claim code from the sticker, and the level, pump button and cutoff work end to end.

### Tests

```bash
cd backend && npm install && npm test        # 18 end-to-end tests against the Docker stack (REST, Socket.IO, MQTT, scheduler)
cd admin-panel && npm run build              # type check + production build
# Flutter (in Docker):
docker run --rm -v $PWD/mobile:/app -w /app ghcr.io/cirruslabs/flutter:stable bash -c "flutter pub get && flutter analyze && flutter test"
```

Admin panel browser smoke test (Playwright in Docker, needs `npm run dev` running and the test admin from `npm test`):

```bash
cd admin-panel/e2e && npm init -y && npm i playwright@1.49.0
docker run --rm --network host -v $PWD:/work -v /tmp:/out -w /work mcr.microsoft.com/playwright:v1.49.0-noble node smoke.cjs /out
```

### Migrations

New schema changes go in `database/migrations/NNN_name.sql` (never edit an applied one). The backend applies pending files on start; `cd backend && npm run migrate:status` lists them. Applied so far: `001` schema, `002` index review + missing columns, `003` MAC-only device login.

## Production

See [DEPLOY.md](DEPLOY.md): `docker-compose.prod.yml` behind the Nginx already running on the VPS (shared with magicoutline), HTTPS by certbot, MQTT over TLS on 8883.
