-- =====================================================================
-- 004: QR stickers carry only a random claim token (WT2:<token>).
-- The app sends the token alone and the backend finds the device by the
-- token's hash, so claim_code_hash needs an index. Old WT1 codes still
-- work (looked up by serial). Not unique: old 8-char codes are scoped
-- by serial and could in theory repeat across devices.
-- =====================================================================
BEGIN;
CREATE INDEX IF NOT EXISTS devices_claim_code_hash_idx ON devices (claim_code_hash) WHERE claim_code_hash IS NOT NULL;
COMMENT ON COLUMN devices.claim_code_hash IS 'HMAC of the claim code (WT2: 16-char token, WT1: 8-char code). NULL after claim.';
COMMIT;
