# Water Level Platform

Backend (Node.js + Express + Socket.IO + MQTT), admin panel, and PostgreSQL for the IoT water tank system.

```
backend/        Node.js API (for now only the migration runner)
admin-panel/    Admin web panel (not started yet)
database/       schema.sql, DESIGN.md, migrations/
mosquitto/      Mosquitto broker config
pgadmin/        pgAdmin server preset
```

## Local setup

```bash
cp .env.example .env           # then change the passwords
docker compose up -d           # postgres, mosquitto, pgadmin
cd backend && npm install && npm run migrate
```

| Service    | Address from WSL / Windows      |
|------------|---------------------------------|
| PostgreSQL | `localhost:5433` (user/db from `.env`) |
| pgAdmin    | http://localhost:5050           |
| MQTT       | `localhost:1883` (websockets `9001`) |

PostgreSQL uses host port 5433 because 5432 is taken by another project on this machine.

### Connect to PostgreSQL

```bash
# inside the container (no install needed)
docker compose exec postgres psql -U waterlevel -d waterlevel

# from WSL directly (needs: sudo apt install postgresql-client)
psql "postgres://waterlevel:<POSTGRES_PASSWORD>@localhost:5433/waterlevel"
```

In pgAdmin the server "waterlevel (docker)" is pre-added; enter `POSTGRES_PASSWORD` when asked.
From pgAdmin the host is `postgres` port `5432` (inside the Docker network), not `localhost:5433`.

### Migrations

New changes go in `database/migrations/NNN_name.sql`. `npm run migrate` applies pending files in order and records them in `schema_migrations`. `npm run migrate:status` lists them.

Mosquitto currently allows anonymous connections. Turn that off before production.
