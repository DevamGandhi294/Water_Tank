-- =====================================================================
-- 003: devices log in to MQTT by MAC only (decision 2026-11-01).
-- The admin registers the board MACs; Mosquitto asks the backend, which
-- accepts a client only if its username = a registered, enabled main MAC.
-- No per-device secret is issued any more, so secret_hash becomes optional
-- (kept as a column so a per-device key can be added later without a
-- schema change).
-- =====================================================================
BEGIN;
ALTER TABLE devices ALTER COLUMN secret_hash DROP NOT NULL;
COMMENT ON COLUMN devices.secret_hash IS 'Unused since 003 (MAC-only MQTT login). Reserved for an optional per-device key.';
COMMENT ON COLUMN devices.mqtt_username IS 'Main board MAC, 12 lowercase hex chars without colons. MQTT username and client id.';
COMMIT;
