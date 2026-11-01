-- =====================================================================
-- 002: one-time review of 001 before the backend goes live.
--
-- What changes and why (each item is small and safe on an empty or
-- small database; all of it runs in one transaction):
--
--  A. Missing columns the API needs
--     * device_invites.declined_at   (7.8 decline an invite)
--     * timers.last_skip_reason      (6.x timer.lastSkipReason)
--     * device_state.sender_ok       (ESP "snd": is the sender board heard)
--  B. Soft delete must free the phone number / Google account
--     (users_login_method now ignores deleted rows, so the backend can
--      clear phone, email and google_sub on DELETE /me).
--  C. Indexes for queries the backend actually runs
--     * FK columns that are deleted / looked up and had no index
--     * partial indexes for the background jobs (expiry, offline sweep)
--     * trigram indexes for the admin search box (serial, name, phone, MAC)
--  D. Indexes replaced by better ones
--     * device_state status / online btrees on low-cardinality columns are
--       replaced by small partial indexes that match admin_stats exactly.
--     * device_commands pending index now orders by expires_at, which is
--       what the expiry job scans.
--  E. Retention helpers (nightly job deletes old rows using these indexes)
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- A. columns -------------------------------------------------
ALTER TABLE device_invites ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE timers         ADD COLUMN IF NOT EXISTS last_skip_reason TEXT;
ALTER TABLE device_state   ADD COLUMN IF NOT EXISTS sender_ok BOOLEAN;

-- ---------- B. soft delete ---------------------------------------------
ALTER TABLE users DROP CONSTRAINT users_login_method;
ALTER TABLE users ADD CONSTRAINT users_login_method CHECK (
  deleted_at IS NOT NULL
  OR (phone IS NOT NULL AND password_hash IS NOT NULL)
  OR google_sub IS NOT NULL
);

-- ---------- C. indexes for real queries --------------------------------
-- refresh token cleanup + session list
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- otp cleanup
CREATE INDEX IF NOT EXISTS otp_codes_expires_idx ON otp_codes (expires_at);

-- members screen: pending invites of one device
CREATE INDEX IF NOT EXISTS device_invites_device_idx ON device_invites (device_id)
  WHERE accepted_at IS NULL AND declined_at IS NULL;
-- the old phone index also has to skip declined invites
DROP INDEX IF EXISTS device_invites_phone_idx;
CREATE INDEX device_invites_phone_idx ON device_invites (phone)
  WHERE accepted_at IS NULL AND declined_at IS NULL;

-- pump_runs.timer_id is ON DELETE SET NULL: deleting a timer would scan pump_runs
CREATE INDEX IF NOT EXISTS pump_runs_timer_idx ON pump_runs (timer_id) WHERE timer_id IS NOT NULL;

-- notifications.event_id is ON DELETE SET NULL: the nightly event cleanup needs it
CREATE INDEX IF NOT EXISTS notifications_event_idx ON notifications (event_id) WHERE event_id IS NOT NULL;
-- cooldown check is per person: (user, device, type, newest first)
DROP INDEX IF EXISTS notifications_cooldown_idx;
CREATE INDEX notifications_cooldown_idx ON notifications (user_id, device_id, type, created_at DESC);
-- device delete cascades on notifications.device_id
CREATE INDEX IF NOT EXISTS notifications_device_idx ON notifications (device_id) WHERE device_id IS NOT NULL;

-- ota_rollouts.release_id is ON DELETE RESTRICT: deleting a release checks it
CREATE INDEX IF NOT EXISTS ota_rollouts_release_idx ON ota_rollouts (release_id);
-- devices still waiting for an OTA when they come online
CREATE INDEX IF NOT EXISTS ota_rollout_devices_open_idx ON ota_rollout_devices (device_id)
  WHERE status IN ('pending', 'sent', 'downloading');

-- admin "open faults" across all devices, newest first
CREATE INDEX IF NOT EXISTS device_events_open_time_idx ON device_events (occurred_at DESC)
  WHERE severity <> 'info' AND resolved_at IS NULL;
-- resolving a fault looks up the open event of one type on one device
DROP INDEX IF EXISTS device_events_open_faults_idx;
CREATE INDEX device_events_open_faults_idx ON device_events (device_id, type)
  WHERE severity <> 'info' AND resolved_at IS NULL;

-- audit filter by actor
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, created_at DESC);

-- admin search box (ILIKE '%...%')
CREATE INDEX IF NOT EXISTS users_name_trgm_idx   ON users   USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_phone_trgm_idx  ON users   USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS devices_serial_trgm_idx ON devices USING gin (serial_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS device_boards_mac_trgm_idx ON device_boards
  USING gin ((replace(mac::text, ':', '')) gin_trgm_ops);
-- firmware version chart on the dashboard
CREATE INDEX IF NOT EXISTS device_boards_fw_idx ON device_boards (role, fw_version) WHERE replaced_at IS NULL;

-- users who logged in recently (admin_stats.users_active_30d)
CREATE INDEX IF NOT EXISTS users_last_login_idx ON users (last_login_at) WHERE last_login_at IS NOT NULL;

-- ---------- D. replaced indexes ----------------------------------------
DROP INDEX IF EXISTS device_state_status_idx;
DROP INDEX IF EXISTS device_state_online_idx;
CREATE INDEX device_state_faulty_idx  ON device_state (device_id) WHERE status IN ('FAULT', 'DOWN');
CREATE INDEX device_state_online_idx  ON device_state (device_id) WHERE is_online;
-- offline sweep: online devices that stopped sending
CREATE INDEX device_state_last_seen_idx ON device_state (last_seen_at) WHERE is_online;

DROP INDEX IF EXISTS device_commands_pending_idx;
CREATE INDEX device_commands_open_idx ON device_commands (expires_at)
  WHERE status IN ('pending', 'sent');

-- timers: the scheduler matches on (start_time) or (stop_time) per time zone;
-- device_id is fetched from the row, so the existing indexes are kept.

-- ---------- E. retention -----------------------------------------------
-- device_commands_device_time_idx and notifications_user_time_idx already
-- cover per-device / per-user lists. For the nightly "older than 1 year"
-- delete a plain created_at index is cheaper than scanning.
CREATE INDEX IF NOT EXISTS device_commands_created_idx ON device_commands (created_at);
CREATE INDEX IF NOT EXISTS notifications_created_idx   ON notifications (created_at);
CREATE INDEX IF NOT EXISTS device_events_occurred_idx  ON device_events (occurred_at);

-- ---------- admin_stats: same numbers, uses the partial indexes ---------
CREATE OR REPLACE VIEW admin_stats AS
  SELECT
    (SELECT count(*) FROM devices)                                        AS total_devices,
    (SELECT count(*) FROM devices WHERE owner_id IS NOT NULL)             AS claimed_devices,
    (SELECT count(*) FROM device_state WHERE is_online)                   AS online_devices,
    (SELECT count(*) FROM device_state WHERE status IN ('FAULT', 'DOWN')) AS faulty_devices,
    (SELECT count(*) FROM users WHERE role = 'user' AND deleted_at IS NULL
                                AND NOT is_blocked)                       AS active_users,
    (SELECT count(*) FROM users WHERE last_login_at > now() - interval '30 days'
                                AND deleted_at IS NULL)                   AS users_active_30d;

COMMIT;
