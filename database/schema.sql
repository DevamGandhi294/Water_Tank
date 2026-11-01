-- =====================================================================
--  Water Level Platform - PostgreSQL schema  (v1)
--  Target: PostgreSQL 14+ (tested on 16), Contabo VPS
--  Backend: Node.js + Express + Socket.IO + MQTT (Mosquitto)
--
--  Rules used everywhere:
--    * All times are TIMESTAMPTZ and stored in UTC. The app shows them
--      in the device's time zone (default Asia/Kolkata).
--    * Secrets (passwords, device secrets, claim codes, tokens, OTPs) are
--      stored only as hashes. Never store the plain value.
--    * Distances come from the ESP in cm (0.1 cm precision).
--      Level % is calculated by the backend only when tank height is set.
--    * Raw sensor data is NOT stored. Only the live state (one row per
--      device), pump runs, events and commands are kept.
--
--  Run:  psql -U postgres -d waterlevel -f schema.sql
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Enum types
-- ---------------------------------------------------------------------
CREATE TYPE user_role        AS ENUM ('super_admin', 'user');   -- super_admin = you (admin panel), user = customer
CREATE TYPE board_role       AS ENUM ('main', 'sender');          -- main = relay ESP, sender = ultrasonic ESP
CREATE TYPE device_status    AS ENUM ('WORK', 'DOWN', 'FAULT', 'CONFIG', 'OTA', 'UNKNOWN');
CREATE TYPE share_permission AS ENUM ('view', 'control');
CREATE TYPE pump_source      AS ENUM ('button', 'app', 'auto', 'timer', 'admin', 'system');
CREATE TYPE pump_stop_reason AS ENUM ('button', 'app', 'auto_cutoff', 'timer', 'admin',
                                      'fault', 'power_loss', 'ota', 'max_runtime', 'unknown');
CREATE TYPE event_type       AS ENUM ('online', 'offline', 'reboot', 'status_change',
                                      'sensor_down', 'sender_fault', 'auto_cutoff',
                                      'on_refused', 'config_mode', 'settings_applied',
                                      'ota_started', 'ota_success', 'ota_failed',
                                      'claimed', 'unclaimed');
CREATE TYPE event_severity   AS ENUM ('info', 'warning', 'critical');
CREATE TYPE command_type     AS ENUM ('pump_on', 'pump_off', 'apply_settings', 'reboot',
                                      'config_mode', 'ota_check');
CREATE TYPE command_status   AS ENUM ('pending', 'sent', 'acked', 'failed', 'expired');
CREATE TYPE alert_type       AS ENUM ('tank_full', 'tank_low', 'sensor_fault',
                                      'device_offline', 'pump_long_run', 'ota_result');
CREATE TYPE ota_status       AS ENUM ('pending', 'sent', 'downloading', 'success',
                                      'failed', 'skipped');
CREATE TYPE otp_purpose      AS ENUM ('verify_phone', 'login', 'reset_password');

-- Helper: keep updated_at current
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 1. Users, login, sessions
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name        TEXT        NOT NULL,
  phone            TEXT        UNIQUE,                -- E.164, e.g. +919876543210
  phone_verified_at TIMESTAMPTZ,
  email            TEXT,                              -- from Google, or optional
  google_sub       TEXT        UNIQUE,                -- Google account id ("sub" claim)
  password_hash    TEXT,                              -- bcrypt / argon2; NULL for Google-only users
  role             user_role   NOT NULL DEFAULT 'user',
  is_blocked       BOOLEAN     NOT NULL DEFAULT false,
  blocked_reason   TEXT,
  blocked_at       TIMESTAMPTZ,
  token_version    INTEGER     NOT NULL DEFAULT 0,    -- bump to invalidate every JWT of this user
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,                       -- soft delete
  -- every user must be able to log in somehow
  CONSTRAINT users_login_method CHECK (
    (phone IS NOT NULL AND password_hash IS NOT NULL) OR google_sub IS NOT NULL
  ),
  CONSTRAINT users_phone_format CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_role_idx ON users (role) WHERE deleted_at IS NULL;
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh tokens (short JWT access token + long refresh token)
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,           -- sha256 of the token
  device_label TEXT,                                  -- "Pixel 7 / Android app"
  ip           INET,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- One-time codes sent by SMS (phone verify, OTP login, password reset)
CREATE TABLE otp_codes (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT        NOT NULL,
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,
  purpose     otp_purpose NOT NULL,
  code_hash   TEXT        NOT NULL,
  attempts    SMALLINT    NOT NULL DEFAULT 0,         -- block after ~5 wrong tries
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_lookup_idx ON otp_codes (phone, purpose, created_at DESC);

-- Phone push tokens (Firebase Cloud Messaging is only used for push)
CREATE TABLE push_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token    TEXT        NOT NULL UNIQUE,
  platform     TEXT        NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id);

-- ---------------------------------------------------------------------
-- 2. Firmware (needed before devices, which point at a version)
-- ---------------------------------------------------------------------
CREATE TABLE firmware_releases (
  id           SERIAL PRIMARY KEY,
  board        board_role  NOT NULL DEFAULT 'main',   -- today only the main board gets OTA
  version      TEXT        NOT NULL,                  -- "1.3"
  file_path    TEXT        NOT NULL,                  -- path on the VPS, e.g. /srv/ota/main_relay_1.3.bin
  file_size    INTEGER     NOT NULL CHECK (file_size > 0),
  sha256       TEXT        NOT NULL,
  notes        TEXT,
  is_stable    BOOLEAN     NOT NULL DEFAULT false,    -- the version new devices should get
  uploaded_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (board, version)
);
-- only one stable release per board
CREATE UNIQUE INDEX firmware_one_stable_uq ON firmware_releases (board) WHERE is_stable;

-- ---------------------------------------------------------------------
-- 3. Devices (one device = one tank = main relay ESP + sender ESP)
-- ---------------------------------------------------------------------
CREATE TABLE devices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_no        TEXT        NOT NULL UNIQUE,       -- printed on the sticker, e.g. WT-2026-00001
  mqtt_username    TEXT        NOT NULL UNIQUE,       -- usually the main board MAC without colons
  secret_hash      TEXT        NOT NULL,              -- device secret for MQTT login (hash only)
  claim_code_hash  TEXT,                              -- QR claim code (hash). NULL after it is claimed
  owner_id         UUID        REFERENCES users(id) ON DELETE SET NULL,  -- one owner only
  claimed_at       TIMESTAMPTZ,
  name             TEXT,                              -- "Home Tank"
  location         TEXT,                              -- "Roof, Block A"
  timezone         TEXT        NOT NULL DEFAULT 'Asia/Kolkata',
  hw_model         TEXT        NOT NULL DEFAULT 'WT-ESP8266-HC12',
  is_disabled      BOOLEAN     NOT NULL DEFAULT false, -- admin can block a device
  registered_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  manufactured_at  DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT devices_claim_consistent CHECK (
    (owner_id IS NULL AND claimed_at IS NULL) OR (owner_id IS NOT NULL AND claimed_at IS NOT NULL)
  )
);
CREATE INDEX devices_owner_idx ON devices (owner_id);
CREATE TRIGGER devices_updated BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The two ESP boards inside one device, each with its own MAC
CREATE TABLE device_boards (
  id            SERIAL PRIMARY KEY,
  device_id     UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  role          board_role  NOT NULL,
  mac           MACADDR     NOT NULL UNIQUE,          -- search by MAC uses this
  fw_version    TEXT,                                 -- last version the board reported
  replaced_at   TIMESTAMPTZ,                          -- set when a board is swapped for repair
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one active main + one active sender per device
CREATE UNIQUE INDEX device_boards_one_per_role_uq
  ON device_boards (device_id, role) WHERE replaced_at IS NULL;

-- Settings the user can change from the app (no reflashing)
CREATE TABLE device_settings (
  device_id           UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  tank_height_cm      NUMERIC(5,1) CHECK (tank_height_cm IS NULL OR tank_height_cm BETWEEN 30 AND 1000),
                                                     -- sensor to tank bottom; NULL = show cm only, no %
  capacity_litres     INTEGER      CHECK (capacity_litres IS NULL OR capacity_litres > 0),
  cutoff_distance_cm  NUMERIC(5,1) NOT NULL DEFAULT 25.0 CHECK (cutoff_distance_cm BETWEEN 25 AND 300),
                                                     -- AUTO CUTOFF: relay OFF when water is this close
                                                     -- to the sensor. Set by the user per device.
                                                     -- Minimum 25 cm (the database refuses less).
  auto_mode           BOOLEAN      NOT NULL DEFAULT true,
  low_level_pct       SMALLINT     NOT NULL DEFAULT 20 CHECK (low_level_pct BETWEEN 0 AND 100),
  full_level_pct      SMALLINT     NOT NULL DEFAULT 95 CHECK (full_level_pct BETWEEN 0 AND 100),
  max_pump_minutes    SMALLINT     CHECK (max_pump_minutes IS NULL OR max_pump_minutes > 0),
  -- Sync with the ESP: server bumps version, sends it over MQTT,
  -- ESP replies with the version it saved -> applied_version.
  version             INTEGER      NOT NULL DEFAULT 1, -- bump on every change
  applied_version     INTEGER      NOT NULL DEFAULT 0, -- what the device confirmed it applied
  sent_at             TIMESTAMPTZ,                     -- last time the server sent settings to the ESP
  applied_at          TIMESTAMPTZ,                     -- last time the ESP confirmed
  updated_by          UUID         REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT settings_low_below_full CHECK (low_level_pct < full_level_pct),
  -- cutoff must be above the tank bottom, otherwise the pump would never stop
  CONSTRAINT settings_cutoff_inside_tank CHECK (tank_height_cm IS NULL OR cutoff_distance_cm < tank_height_cm)
);
CREATE TRIGGER device_settings_updated BEFORE UPDATE ON device_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- History of every settings change (e.g. cutoff 25 -> 35 cm), who did it,
-- and when the ESP confirmed it. Filled automatically by the trigger below.
CREATE TABLE settings_changes (
  id                 BIGSERIAL PRIMARY KEY,
  device_id          UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  version            INTEGER      NOT NULL,
  changed_by         UUID         REFERENCES users(id) ON DELETE SET NULL,
  old_values         JSONB        NOT NULL,           -- {"cutoff_distance_cm": 25.0}
  new_values         JSONB        NOT NULL,           -- {"cutoff_distance_cm": 35.0}
  changed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  applied_at         TIMESTAMPTZ,                     -- set when the ESP acks this version
  UNIQUE (device_id, version)
);

CREATE FUNCTION log_settings_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o JSONB := to_jsonb(OLD) - '{version,applied_version,sent_at,applied_at,updated_by,updated_at}'::text[];
  n JSONB := to_jsonb(NEW) - '{version,applied_version,sent_at,applied_at,updated_by,updated_at}'::text[];
  k TEXT;
  old_diff JSONB := '{}';
  new_diff JSONB := '{}';
BEGIN
  IF o = n THEN
    -- only sync columns changed (e.g. ESP ack): mark that version applied
    IF NEW.applied_version > OLD.applied_version THEN
      UPDATE settings_changes SET applied_at = COALESCE(NEW.applied_at, now())
       WHERE device_id = NEW.device_id AND version <= NEW.applied_version AND applied_at IS NULL;
    END IF;
    RETURN NEW;
  END IF;
  -- a real setting changed: bump version so the server knows to send it
  NEW.version := OLD.version + 1;
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    IF o->k IS DISTINCT FROM n->k THEN
      old_diff := old_diff || jsonb_build_object(k, o->k);
      new_diff := new_diff || jsonb_build_object(k, n->k);
    END IF;
  END LOOP;
  INSERT INTO settings_changes (device_id, version, changed_by, old_values, new_values)
  VALUES (NEW.device_id, NEW.version, NEW.updated_by, old_diff, new_diff);
  RETURN NEW;
END $$;

CREATE TRIGGER device_settings_log BEFORE UPDATE ON device_settings
  FOR EACH ROW EXECUTE FUNCTION log_settings_change();

-- Live state: exactly one row per device, overwritten by every MQTT
-- message. This is what the app and admin dashboard read. Not history.
CREATE TABLE device_state (
  device_id        UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  is_online        BOOLEAN       NOT NULL DEFAULT false,  -- set false by MQTT last-will
  status           device_status NOT NULL DEFAULT 'UNKNOWN',
  pump_on          BOOLEAN       NOT NULL DEFAULT false,
  distance_cm      NUMERIC(5,1),                          -- NULL = no valid echo
  level_pct        SMALLINT      CHECK (level_pct IS NULL OR level_pct BETWEEN 0 AND 100),
  fw_version       TEXT,
  wifi_rssi        SMALLINT,
  ip               INET,
  uptime_s         INTEGER,
  last_seen_at     TIMESTAMPTZ,
  online_since     TIMESTAMPTZ,
  offline_since    TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX device_state_status_idx ON device_state (status);
CREATE INDEX device_state_online_idx ON device_state (is_online);

-- ---------------------------------------------------------------------
-- 4. Shared access (family members)
-- ---------------------------------------------------------------------
CREATE TABLE device_shares (
  device_id    UUID             NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id      UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission   share_permission NOT NULL DEFAULT 'view',
  invited_by   UUID             REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, user_id)
);
CREATE INDEX device_shares_user_idx ON device_shares (user_id);

-- Invite by phone number before the person has an account
CREATE TABLE device_invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID             NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  phone        TEXT             NOT NULL,
  permission   share_permission NOT NULL DEFAULT 'view',
  token_hash   TEXT             NOT NULL UNIQUE,
  invited_by   UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ      NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_by  UUID             REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX device_invites_phone_idx ON device_invites (phone) WHERE accepted_at IS NULL;

-- ---------------------------------------------------------------------
-- 5. Pump run log, events, commands
-- ---------------------------------------------------------------------
-- One row per ON -> OFF cycle. Open row (ended_at NULL) = pump running now.
CREATE TABLE pump_runs (
  id               BIGSERIAL PRIMARY KEY,
  device_id        UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  duration_s       INTEGER GENERATED ALWAYS AS
                     (CASE WHEN ended_at IS NULL THEN NULL
                           ELSE EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER END) STORED,
  start_source     pump_source NOT NULL,
  started_by       UUID        REFERENCES users(id) ON DELETE SET NULL,  -- set when source = app/admin
  stop_reason      pump_stop_reason,
  stopped_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  start_distance_cm NUMERIC(5,1),
  end_distance_cm   NUMERIC(5,1),
  start_level_pct  SMALLINT,
  end_level_pct    SMALLINT,
  timer_id         BIGINT,                             -- FK added below (timers table)
  CONSTRAINT pump_runs_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX pump_runs_device_time_idx ON pump_runs (device_id, started_at DESC);
-- a device can have only one pump run open at a time
CREATE UNIQUE INDEX pump_runs_one_open_uq ON pump_runs (device_id) WHERE ended_at IS NULL;

-- Faults, auto cutoffs, reboots, online/offline, OTA results...
CREATE TABLE device_events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    UUID           NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type         event_type     NOT NULL,
  severity     event_severity NOT NULL DEFAULT 'info',
  occurred_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  message      TEXT,
  data         JSONB,                                  -- e.g. {"from":"WORK","to":"FAULT"}
  resolved_at  TIMESTAMPTZ                             -- for faults: when it cleared
);
CREATE INDEX device_events_device_time_idx ON device_events (device_id, occurred_at DESC);
CREATE INDEX device_events_open_faults_idx ON device_events (device_id)
  WHERE severity <> 'info' AND resolved_at IS NULL;

-- Every command sent to a device from the app/admin/scheduler, with its ack
CREATE TABLE device_commands (
  id            BIGSERIAL PRIMARY KEY,
  device_id     UUID           NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type          command_type   NOT NULL,
  payload       JSONB,
  source        pump_source    NOT NULL,               -- app / timer / admin / system
  requested_by  UUID           REFERENCES users(id) ON DELETE SET NULL,
  status        command_status NOT NULL DEFAULT 'pending',
  error         TEXT,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  acked_at      TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ    NOT NULL DEFAULT now() + interval '30 seconds'
);
CREATE INDEX device_commands_device_time_idx ON device_commands (device_id, created_at DESC);
CREATE INDEX device_commands_pending_idx ON device_commands (device_id)
  WHERE status IN ('pending', 'sent');

-- ---------------------------------------------------------------------
-- 6. Timers  (daily start / stop time for the pump)
--    Example: ON 06:00, OFF 06:30, every day
--             ON 18:00, OFF 18:20, Mon-Fri, only if level below 50%
--    The backend checks timers every minute and sends pump_on / pump_off.
--    The ESP's own 25+ cm auto cutoff still stops the pump early if the
--    tank gets full before the stop time.
-- ---------------------------------------------------------------------
CREATE TABLE timers (
  id                 BIGSERIAL PRIMARY KEY,
  device_id          UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  name               TEXT,                             -- "Morning fill"
  start_time         TIME        NOT NULL,             -- pump ON  (local time in devices.timezone)
  stop_time          TIME        NOT NULL,             -- pump OFF (if earlier than start = next day)
  days_mask          SMALLINT    NOT NULL DEFAULT 127  -- bit 0 = Monday ... bit 6 = Sunday; 127 = every day
                       CHECK (days_mask BETWEEN 1 AND 127),
  only_if_below_pct  SMALLINT    CHECK (only_if_below_pct IS NULL OR only_if_below_pct BETWEEN 1 AND 100),
                                                     -- skip the start if the tank is already this full
  is_enabled         BOOLEAN     NOT NULL DEFAULT true,
  last_started_at    TIMESTAMPTZ,
  last_stopped_at    TIMESTAMPTZ,
  last_skipped_at    TIMESTAMPTZ,                      -- start skipped (tank already full / device offline)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT timers_start_ne_stop CHECK (start_time <> stop_time)
);
CREATE INDEX timers_start_idx ON timers (start_time) WHERE is_enabled;
CREATE INDEX timers_stop_idx  ON timers (stop_time)  WHERE is_enabled;
CREATE INDEX timers_device_idx ON timers (device_id);
CREATE TRIGGER timers_updated BEFORE UPDATE ON timers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE pump_runs
  ADD CONSTRAINT pump_runs_timer_fk FOREIGN KEY (timer_id)
  REFERENCES timers(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- 7. Alerts and notifications
-- ---------------------------------------------------------------------
-- Per user, per device, per alert type. No row = use the default (enabled).
CREATE TABLE alert_settings (
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type           alert_type  NOT NULL,
  is_enabled     BOOLEAN     NOT NULL DEFAULT true,
  threshold      SMALLINT,                             -- % for low/full, minutes for offline/long run
  quiet_from     TIME,                                 -- optional "do not disturb" window
  quiet_to       TIME,
  PRIMARY KEY (user_id, device_id, type)
);

-- What was sent (also the in-app notification list)
CREATE TABLE notifications (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    UUID        REFERENCES devices(id) ON DELETE CASCADE,
  type         alert_type  NOT NULL,
  title        TEXT        NOT NULL,
  body         TEXT        NOT NULL,
  event_id     BIGINT      REFERENCES device_events(id) ON DELETE SET NULL,
  push_sent    BOOLEAN     NOT NULL DEFAULT false,
  push_error   TEXT,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_time_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
-- used to avoid sending the same alert again and again (cooldown check)
CREATE INDEX notifications_cooldown_idx ON notifications (device_id, type, created_at DESC);

-- ---------------------------------------------------------------------
-- 8. OTA rollouts (push an update to one device or to all)
-- ---------------------------------------------------------------------
CREATE TABLE ota_rollouts (
  id           SERIAL PRIMARY KEY,
  release_id   INTEGER     NOT NULL REFERENCES firmware_releases(id) ON DELETE RESTRICT,
  target_all   BOOLEAN     NOT NULL DEFAULT false,     -- true = every device; false = listed devices
  created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE ota_rollout_devices (
  rollout_id    INTEGER     NOT NULL REFERENCES ota_rollouts(id) ON DELETE CASCADE,
  device_id     UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status        ota_status  NOT NULL DEFAULT 'pending',
  from_version  TEXT,
  error         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rollout_id, device_id)
);
CREATE INDEX ota_rollout_devices_device_idx ON ota_rollout_devices (device_id, updated_at DESC);

-- ---------------------------------------------------------------------
-- 9. Admin audit log (who did what in the admin panel)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT        NOT NULL,                   -- 'device.register', 'user.block', 'ota.push'...
  target_type  TEXT,                                   -- 'device', 'user', 'firmware'
  target_id    TEXT,
  data         JSONB,
  ip           INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);

-- ---------------------------------------------------------------------
-- 10. Helper view: who can see which device, and with what rights
--     The backend checks every request with:
--       SELECT access FROM device_access WHERE device_id = $1 AND user_id = $2
-- ---------------------------------------------------------------------
CREATE VIEW device_access AS
  SELECT d.id AS device_id, d.owner_id AS user_id, 'owner'::TEXT AS access
    FROM devices d WHERE d.owner_id IS NOT NULL
  UNION ALL
  SELECT s.device_id, s.user_id, s.permission::TEXT
    FROM device_shares s;

-- Admin dashboard numbers in one query
CREATE VIEW admin_stats AS
  SELECT
    (SELECT count(*) FROM devices)                                        AS total_devices,
    (SELECT count(*) FROM devices WHERE owner_id IS NOT NULL)             AS claimed_devices,
    (SELECT count(*) FROM device_state WHERE is_online)                   AS online_devices,
    (SELECT count(*) FROM device_state WHERE status IN ('FAULT', 'DOWN')) AS faulty_devices,
    (SELECT count(*) FROM users WHERE role = 'user' AND deleted_at IS NULL
                                AND NOT is_blocked)                       AS active_users,
    (SELECT count(*) FROM users WHERE last_login_at > now() - interval '30 days') AS users_active_30d;

COMMIT;

-- =====================================================================
-- OPTIONAL (not created): level history for graphs.
-- You said not to store ESP data, so this is left out. If you later want
-- day/week/month graphs, this keeps just 24 small rows per device per day
-- (the backend averages in memory and writes once an hour):
--
-- CREATE TABLE level_hourly (
--   device_id    UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
--   hour         TIMESTAMPTZ NOT NULL,
--   avg_cm       NUMERIC(5,1), min_cm NUMERIC(5,1), max_cm NUMERIC(5,1),
--   avg_pct      SMALLINT,
--   pump_on_s    INTEGER     NOT NULL DEFAULT 0,
--   PRIMARY KEY (device_id, hour)
-- );
-- =====================================================================
