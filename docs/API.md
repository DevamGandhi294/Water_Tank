# Water Level Platform: API list (v1)

Derived screen by screen from the app and admin panel design (see the clickable mockup). Every endpoint maps to tables in [`database/schema.sql`](../database/schema.sql) plus migrations 002–003. **Implemented** in `backend/` and covered by `backend/test/api.test.js`. The firmware side is in [DEVICE-API.md](DEVICE-API.md).

### Changes made while building (2026-11-01)

| Area | Change |
|---|---|
| Sign-up | No SMS provider yet (`SMS_PROVIDER=none`). `POST /auth/register` returns the login response at once with `otpSent: false`. `/auth/otp/*`, `/me/phone*` return `501 NOT_ENABLED` until SMS is turned on; with `SMS_PROVIDER=msg91` they work as written below. |
| Google sign-in | Skipped for now: `POST /auth/google` returns `501 NOT_ENABLED`. |
| Password reset | Done by the admin: **new** `POST /admin/users/:id/password {newPassword}` → `204`, logs the user out everywhere. |
| Device login | MQTT login by registered **main board MAC** only, no device secret. `POST /admin/devices` no longer returns `deviceSecret`; `POST /admin/devices/:id/secret` returns `501`. |
| Claim | `POST /devices/claim/check` and `/devices/claim` also accept `{qr: "WT2:<token>"}` (or old `{qr: "WT1:<serial>:<code>"}`) instead of `serial` + `claimCode`. A 16-char token needs no serial. |
| Logout | `POST /auth/logout` deletes the refresh token. Re-using an already **rotated** refresh token logs the user out everywhere (token theft protection). |
| Pump run summary | `period=day` → 24 hourly buckets for today, `week` → last 7 days, `month` → last 30 days, in the device time zone. |
| Extra fields | `deviceCard.isDisabled`; `deviceDetail.state.fwVersion/senderOk`; admin device detail adds `mqttUsername`, `claimCodeActive`, `boardHistory`. Bulk register returns `stickerSheetHtml` (printable A4). |
| Errors | Validation problems are `400 VALIDATION` with `field`; business rules (cutoff, height, timers) are `422`. |
| One-off events | `on_refused` and `ota_failed` events are stored already resolved, so they never show as open faults. |

Stack: Node.js + Express, PostgreSQL (Docker, port 5433), Mosquitto, Socket.IO. FCM is used only for push.

## Conventions

| Item | Rule |
|---|---|
| Base URL | `https://<contabo-host>/api/v1` (local: `http://localhost:3000/api/v1`) |
| Auth | `Authorization: Bearer <accessToken>`. Access token = JWT, 15 min, carries `sub`, `role`, `tv` (users.token_version). Refresh token = random string, 30 days, stored hashed in `refresh_tokens`, rotated on every refresh. |
| Roles | **public** = no token. **user** = any logged-in account. **owner / control / view** = access to that device from the `device_access` view. **admin** = `super_admin`. Admin passes every device check. |
| Device access rule | view: read only. control: view + pump ON/OFF + timers. owner: control + settings, sharing, rename, remove. |
| Phone | E.164 (`+919876543210`). |
| Time | ISO 8601 UTC in JSON. The app converts with `device.timezone` (default `Asia/Kolkata`). Timer times are local `HH:mm`. |
| Lists | `?limit=20&cursor=<opaque>` → `{ "items": [...], "nextCursor": "..." \| null }` |
| Errors | `{ "error": { "code": "CUTOFF_TOO_LOW", "message": "Cutoff must be at least 25 cm", "field": "cutoffCm" } }` with 400 / 401 / 403 / 404 / 409 / 422 / 429. |
| Blocked user | Any call returns `403 USER_BLOCKED`, and refresh fails. |
| Rate limits | Login, OTP and claim: about 5 tries per 10 min per phone / IP → `429`. |

---

## 1. Auth (app + admin panel)

Screens: Login, Sign up, Verify phone, Forgot password.

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 1.1 | POST | `/auth/register` | public | `{fullName, phone, password}` → `201 {userId, otpSent: true}`. Creates the user with `phone_verified_at = null` and sends an OTP (`verify_phone`). 409 `PHONE_TAKEN`. |
| 1.2 | POST | `/auth/otp/send` | public | `{phone, purpose: "verify_phone" \| "login" \| "reset_password"}` → `{sent: true, resendAfterS: 30}`. |
| 1.3 | POST | `/auth/otp/verify` | public | `{phone, purpose, code}` → for `verify_phone` / `login`: the login response below. For `reset_password`: `{resetToken}` (10 min). |
| 1.4 | POST | `/auth/login` | public | `{phone, password, deviceLabel?}` → `{accessToken, refreshToken, user}`. 401 `BAD_CREDENTIALS`, 403 `PHONE_NOT_VERIFIED`, 403 `USER_BLOCKED`. |
| 1.5 | POST | `/auth/google` | public | `{idToken, deviceLabel?}` → login response. Verifies the Google ID token, matches `google_sub`, otherwise email, otherwise creates a user. Response has `isNewUser`. |
| 1.6 | POST | `/auth/refresh` | public | `{refreshToken}` → `{accessToken, refreshToken}` (old one revoked). |
| 1.7 | POST | `/auth/logout` | user | `{refreshToken}` → `204`. |
| 1.8 | POST | `/auth/logout-all` | user | → `204`. Bumps `token_version`, revokes all refresh tokens. |
| 1.9 | POST | `/auth/password/reset` | public | `{resetToken, newPassword}` → `204`. Also logs out everywhere. |

`user` object (used everywhere):
```json
{ "id": "uuid", "fullName": "Devv", "phone": "+919876543210", "email": null,
  "role": "user", "hasPassword": true, "googleLinked": false, "createdAt": "..." }
```

## 2. My account

Screen: Profile.

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 2.1 | GET | `/me` | user | → `user` + `{unreadNotifications}` |
| 2.2 | PATCH | `/me` | user | `{fullName?, email?}` → `user` |
| 2.3 | POST | `/me/password` | user | `{currentPassword?, newPassword}` → `204`. `currentPassword` not needed if the user had none (Google-only). |
| 2.4 | POST | `/me/phone` | user | `{phone}` → sends OTP; confirm with 2.5. For Google users who add a phone. |
| 2.5 | POST | `/me/phone/verify` | user | `{phone, code}` → `user` |
| 2.6 | POST | `/me/push-tokens` | user | `{fcmToken, platform: "android" \| "ios" \| "web"}` → `204`. Upsert, call on every app start. |
| 2.7 | DELETE | `/me/push-tokens/:fcmToken` | user | → `204`. Call on logout. |
| 2.8 | GET | `/me/sessions` | user | → list of refresh tokens `{id, deviceLabel, ip, createdAt, current}` |
| 2.9 | DELETE | `/me/sessions/:id` | user | → `204` |
| 2.10 | DELETE | `/me` | user | `{password?}` → `204`. Soft delete. Owned devices are released (owner_id = null, new claim code needed from admin). |

## 3. My tanks (devices)

Screens: Home (tank list), Add tank (QR scan), Tank detail, Tank settings.

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 3.1 | GET | `/devices` | user | → `{items: [deviceCard]}`. Owned + shared, no paging (a user has few tanks). |
| 3.2 | POST | `/devices/claim/check` | user | `{qr}`, `{claimCode}` (16-char token) or `{serial, claimCode}` (old 8-char code) → `{serial, hwModel, registeredAt, available: true}`. Lets the app show "WT-2026-00001, registered 02 Nov 2026" before confirming. 404 `INVALID_CODE` (also for an already used token), 409 `ALREADY_CLAIMED`. |
| 3.3 | POST | `/devices/claim` | user | `{serial?, claimCode, name, location?, tankHeightCm?, capacityLitres?}` → `201 deviceDetail`. Sets owner, clears `claim_code_hash`, writes `claimed` event. |
| 3.4 | GET | `/devices/:id` | view | → `deviceDetail` |
| 3.5 | PATCH | `/devices/:id` | owner | `{name?, location?, timezone?}` → `deviceDetail` |
| 3.6 | DELETE | `/devices/:id` | owner | → `204`. Removes the device from the account (owner = null, shares deleted, `unclaimed` event). The QR can't be reused; admin issues a new claim code. Confirm screen in app. |
| 3.7 | DELETE | `/devices/:id/me` | view/control | → `204`. A shared member leaves the device. |

`deviceCard`:
```json
{ "id": "uuid", "serial": "WT-2026-00001", "name": "Home Tank", "location": "Roof",
  "access": "owner",
  "state": { "online": true, "status": "WORK", "pumpOn": false,
             "distanceCm": 62.4, "levelPct": 71, "lastSeenAt": "..." } }
```

`deviceDetail` = `deviceCard` +
```json
{ "timezone": "Asia/Kolkata", "hwModel": "WT-ESP8266-HC12",
  "boards": [ { "role": "main", "mac": "A4:CF:12:...", "fwVersion": "1.3" },
              { "role": "sender", "mac": "84:F3:EB:...", "fwVersion": null } ],
  "settings": { ...see 4.1... },
  "state": { ...deviceCard.state, "wifiRssi": -61, "uptimeS": 86400, "onlineSince": "...", "offlineSince": null },
  "openPumpRun": { "id": 812, "startedAt": "...", "startSource": "app", "startedBy": "Devv" } }
```

Level %: `(tankHeight − distance) / (tankHeight − cutoff) × 100`, clamped 0–100. `levelPct = null` when `tankHeightCm` is not set; the app then shows cm only.

## 4. Settings: cutoff, tank height, auto mode

Screen: Tank settings. The "Sending to device… / Saved on device ✓" badge comes from `version` vs `appliedVersion`.

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 4.1 | GET | `/devices/:id/settings` | view | → settings |
| 4.2 | PATCH | `/devices/:id/settings` | owner | `{cutoffCm?, tankHeightCm?, capacityLitres?, autoMode?, lowLevelPct?, fullLevelPct?, maxPumpMinutes?}` → `{settings, sync: "sending" \| "queued_offline"}`. Backend publishes `settings/set` at once if online, otherwise on reconnect. |
| 4.3 | GET | `/devices/:id/settings/history` | owner | → `{items: [{version, changedBy, old, new, changedAt, appliedAt}]}` from `settings_changes` |

settings:
```json
{ "cutoffCm": 35.0, "tankHeightCm": 180.0, "capacityLitres": 1000, "autoMode": true,
  "lowLevelPct": 20, "fullLevelPct": 95, "maxPumpMinutes": 60,
  "version": 4, "appliedVersion": 4, "appliedAt": "...", "sync": "applied" }
```
Validation (same as the DB): `cutoffCm` 25–300 → `422 CUTOFF_TOO_LOW / CUTOFF_TOO_HIGH`; `cutoffCm < tankHeightCm` → `422 CUTOFF_OUTSIDE_TANK`; `tankHeightCm` 30–1000; `lowLevelPct < fullLevelPct`.

## 5. Pump control

Screen: Tank detail (big ON/OFF button).

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 5.1 | POST | `/devices/:id/pump` | control | `{action: "on" \| "off"}` → `202 {commandId, status: "sent"}`. 409 `DEVICE_OFFLINE`, 409 `TANK_FULL` (ON refused: distance already ≤ cutoff), 409 `SENSOR_FAULT` when status is FAULT/DOWN and safety is on. The final result arrives on Socket.IO `command:result` and `device:state`. |
| 5.2 | GET | `/devices/:id/commands/:commandId` | control | → `{id, type, status: "pending" \| "sent" \| "acked" \| "failed" \| "expired", error}`. Fallback if the socket is not connected. |

## 6. Timers

Screens: Timers list, Add / edit timer.

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 6.1 | GET | `/devices/:id/timers` | view | → `{items: [timer]}` |
| 6.2 | POST | `/devices/:id/timers` | control | `{name?, startTime: "06:00", stopTime: "06:30", days: ["mon",...], onlyIfBelowPct?, enabled}` → `201 timer`. 422 if start = stop. Max 8 per device. |
| 6.3 | PATCH | `/devices/:id/timers/:timerId` | control | any field of 6.2 → `timer` |
| 6.4 | DELETE | `/devices/:id/timers/:timerId` | control | → `204` |

timer: `{id, name, startTime, stopTime, days, onlyIfBelowPct, enabled, endsNextDay, nextRunAt, lastStartedAt, lastSkippedAt, lastSkipReason}`. `days` is stored as `days_mask` (bit 0 = Mon).

## 7. Sharing (family)

Screens: Share tank, Invites (for the person being invited).

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 7.1 | GET | `/devices/:id/members` | owner | → `{owner: user, members: [{userId, fullName, phone, permission, since}], invites: [{id, phone, permission, expiresAt}]}` |
| 7.2 | POST | `/devices/:id/invites` | owner | `{phone, permission: "view" \| "control"}` → `201 invite`. If the phone already has an account it shows in their app at once; otherwise an SMS with an app link is sent and it is accepted after sign-up. Expires in 7 days. |
| 7.3 | DELETE | `/devices/:id/invites/:inviteId` | owner | → `204` (cancel) |
| 7.4 | PATCH | `/devices/:id/members/:userId` | owner | `{permission}` → member |
| 7.5 | DELETE | `/devices/:id/members/:userId` | owner | → `204` (remove access) |
| 7.6 | GET | `/invites` | user | → invites waiting for my phone: `{id, deviceName, ownerName, permission, expiresAt}` |
| 7.7 | POST | `/invites/:id/accept` | user | → `deviceCard` |
| 7.8 | POST | `/invites/:id/decline` | user | → `204` |

## 8. History: pump runs and events

Screens: Pump log, Activity (events).

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 8.1 | GET | `/devices/:id/pump-runs?from&to&limit&cursor` | view | → `{items: [{id, startedAt, endedAt, durationS, startSource, startedBy, stopReason, stoppedBy, startLevelPct, endLevelPct, startDistanceCm, endDistanceCm, timerName}]}` |
| 8.2 | GET | `/devices/:id/pump-runs/summary?period=day\|week\|month` | view | → `{buckets: [{date, runs, totalS}], totalS, runs}`. Feeds the run-time bar chart (from `pump_runs`, so no level history needed). |
| 8.3 | GET | `/devices/:id/events?severity&type&limit&cursor` | view | → `{items: [{id, type, severity, message, data, occurredAt, resolvedAt}]}` |

## 9. Alerts and notifications

Screens: Notifications (bell), Alert settings (per tank).

| # | Method | Path | Role | Body → Response |
|---|---|---|---|---|
| 9.1 | GET | `/notifications?unread=true&limit&cursor` | user | → `{items: [{id, deviceId, deviceName, type, title, body, createdAt, readAt}], unread}` |
| 9.2 | POST | `/notifications/read` | user | `{ids: [..]}` or `{all: true}` → `204` |
| 9.3 | GET | `/devices/:id/alerts` | view | → my settings for every alert type, defaults filled in: `[{type, enabled, threshold, quietFrom, quietTo}]` |
| 9.4 | PUT | `/devices/:id/alerts` | view | same array → saved array. Each member sets their own. |

Alert types: `tank_full` (threshold %), `tank_low` (%), `sensor_fault`, `device_offline` (minutes before alerting), `pump_long_run` (minutes), `ota_result`.

---

## 10. Admin panel (super_admin only)

All paths start with `/admin`. Every write also inserts into `audit_log`.

### Dashboard
| # | Method | Path | Body → Response |
|---|---|---|---|
| 10.1 | GET | `/admin/stats` | → `admin_stats` view: `{totalDevices, claimedDevices, onlineDevices, faultyDevices, activeUsers, usersActive30d}` + `{fwVersions: [{version, count}]}` |
| 10.2 | GET | `/admin/events?severity=warning,critical&open=true&limit` | → latest faults across all devices, with device serial and owner |

### Devices
| # | Method | Path | Body → Response |
|---|---|---|---|
| 10.3 | GET | `/admin/devices?q&status&online&claimed&fw&limit&cursor` | `q` matches serial, MAC (with or without colons), owner name or phone. → `{items: [{id, serial, macMain, macSender, owner, name, state, fwVersion, createdAt}], total}` |
| 10.4 | POST | `/admin/devices` | `{macMain, macSender, hwModel?, manufacturedAt?, serial?}` → `201 {device, serial, registeredAt, mqttUsername, claimCode, qrPayload, qrPngBase64}`. **`claimCode` is shown only in this response** (only its hash is stored). 409 `MAC_EXISTS`. Serial auto: `WT-<year>-<5 digits>`. |
| 10.5 | POST | `/admin/devices/bulk` | `{rows: [{macMain, macSender}]}` (CSV upload in UI) → per-row result like 10.4, plus a printable sticker sheet. |
| 10.6 | GET | `/admin/devices/:id` | → `deviceDetail` + owner, members, last 20 events, last 20 commands, OTA history, settings history |
| 10.7 | PATCH | `/admin/devices/:id` | `{name?, location?, hwModel?, isDisabled?}` → device. Disabled: MQTT login refused, app shows "Disabled by support". |
| 10.8 | POST | `/admin/devices/:id/claim-code` | → `{serial, registeredAt, claimCode, qrPayload, qrPngBase64}`. New code (old one stops working). Use for a lost sticker or a resold device. |
| 10.9 | POST | `/admin/devices/:id/secret` | `501`: devices log in by MAC only, there is no secret. |
| 10.10 | POST | `/admin/devices/:id/unclaim` | `{reason}` → `204`. Removes owner + shares. |
| 10.11 | POST | `/admin/devices/:id/transfer` | `{toPhone}` → device. Moves ownership. |
| 10.12 | POST | `/admin/devices/:id/boards` | `{role, mac}` → replaces a board for repair (old row gets `replaced_at`). |
| 10.13 | POST | `/admin/devices/:id/commands` | `{type: "pump_on" \| "pump_off" \| "reboot" \| "config_mode" \| "ota_check" \| "apply_settings"}` → `202 {commandId}` |
| 10.14 | PATCH | `/admin/devices/:id/settings` | same as 4.2, for support |
| 10.15 | DELETE | `/admin/devices/:id` | → `204`. Only if never claimed (mistyped MAC). |

QR payload (printed on the sticker): `WT2:<token>` e.g. `WT2:K7P29XQM4HTRB2WD`. The token is 16 random chars (about 78 bits), used once, stored only as an HMAC. The QR holds no serial, MAC or date, so a normal scanner shows only random letters; the backend finds the device by the token hash. The serial, registration date and the code (as `K7P2-9XQM-4HTR-B2WD`, for typing) are printed beside the QR. Old stickers `WT1:<serial>:<8-char code>` still work. The admin panel can read the board MACs over USB (Chrome/Edge, Web Serial) when registering.

### Users
| # | Method | Path | Body → Response |
|---|---|---|---|
| 10.16 | GET | `/admin/users?q&role&blocked&limit&cursor` | → `{items: [{id, fullName, phone, email, role, isBlocked, devicesOwned, devicesShared, lastLoginAt, createdAt}], total}` |
| 10.17 | GET | `/admin/users/:id` | → user + owned devices + shared devices + sessions + recent notifications |
| 10.18 | POST | `/admin/users/:id/block` | `{reason}` → `204`. Bumps `token_version` (logs out at once). |
| 10.19 | POST | `/admin/users/:id/unblock` | → `204` |
| 10.20 | POST | `/admin/users/:id/logout-all` | → `204` |
| 10.21 | PATCH | `/admin/users/:id` | `{fullName?, role?}` → user. Can't remove your own super_admin role. |
| 10.21b | POST | `/admin/users/:id/password` | `{newPassword}` → `204`. Admin sets a new password (no SMS reset yet); logs the user out everywhere. |

### Firmware and OTA
| # | Method | Path | Body → Response |
|---|---|---|---|
| 10.22 | GET | `/admin/firmware` | → `{items: [{id, board, version, fileSize, sha256, notes, isStable, uploadedBy, createdAt, devicesOnIt}]}` |
| 10.23 | POST | `/admin/firmware` | multipart: `file` (.bin, max 1 MB), `version`, `board`, `notes` → `201 release`. Backend computes sha256, saves to `/srv/ota/`. 409 if version exists. |
| 10.24 | PATCH | `/admin/firmware/:id` | `{isStable?, notes?}` → release |
| 10.25 | DELETE | `/admin/firmware/:id` | → `204`. Refused if used by a rollout. |
| 10.26 | POST | `/admin/ota/rollouts` | `{releaseId, targetAll: true}` or `{releaseId, deviceIds: [...]}` or `{releaseId, filter: {fwBelow: "1.3"}}` → `201 {rolloutId, devices: n}` |
| 10.27 | GET | `/admin/ota/rollouts` | → list with counts per status |
| 10.28 | GET | `/admin/ota/rollouts/:id` | → `{rollout, devices: [{deviceId, serial, status, fromVersion, error, updatedAt}]}` |
| 10.29 | POST | `/admin/ota/rollouts/:id/cancel` | → `204`. Devices still `pending` become `skipped`. |
| 10.30 | POST | `/admin/ota/rollouts/:id/retry` | → re-sends to `failed` devices |

### Audit
| # | Method | Path | Body → Response |
|---|---|---|---|
| 10.31 | GET | `/admin/audit?actor&action&target&limit&cursor` | → audit_log rows |

---

## 11. Device-facing HTTP (firmware)

| # | Method | Path | Auth | Purpose |
|---|---|---|---|---|
| 11.1 | GET | `/fw/:releaseId.bin` | `?t=<signed token>` from the MQTT OTA message (10 min) | Firmware download. Replaces copying files to `/var/www/watertank/ota/` by SSH. |
| 11.2 | GET | `/ota/version.json` | public | Kept during migration so v1.3 boards still update. Generated from the stable release. |

---

## 12. Socket.IO (live app and admin panel)

Connect: `io("https://<host>", { auth: { token: accessToken } })`. Rooms: `device:<id>` (users with access), `admin` (super_admin).

| Direction | Event | Payload | Used by |
|---|---|---|---|
| client → server | `device:subscribe` | `{deviceIds: [...]}` | Home, Tank detail. Server checks access, joins rooms, replies with current state. |
| client → server | `device:unsubscribe` | `{deviceIds}` | leaving a screen |
| server → client | `device:state` | `{deviceId, online, status, pumpOn, distanceCm, levelPct, lastSeenAt}` | live tank. Sent only when something changed, at most 1 per second. |
| server → client | `device:online` | `{deviceId, online, at}` | online/offline dot |
| server → client | `command:result` | `{commandId, deviceId, type, status, error}` | ON/OFF button spinner |
| server → client | `settings:sync` | `{deviceId, version, appliedVersion, sync: "sending" \| "applied" \| "queued_offline"}` | "Saved on device ✓" badge |
| server → client | `pump:run` | `{deviceId, run}` (opened or closed) | pump log, timer of current run |
| server → client | `device:event` | `{deviceId, event}` | activity list, fault banner |
| server → client | `notification` | `{notification}` | bell badge in app |
| server → client | `access:changed` | `{deviceId, access \| null}` | when a share is added/removed |
| server → admin | `admin:stats` | same as 10.1 | dashboard tiles, every 10 s if changed |
| server → admin | `ota:progress` | `{rolloutId, deviceId, status}` | rollout page |

Expired token → server emits `auth:expired` and disconnects; the app refreshes and reconnects.

## 13. MQTT topics (ESP ↔ backend)

Broker: Mosquitto with TLS on 8883 (1883 only on localhost/LAN for testing). Username = client id = `devices.mqtt_username` (main MAC, 12 lowercase hex, no colons); the password must be non-empty but is ignored (MAC-only login, checked by the backend through mosquitto-go-auth). ACL: a device can only use its own `wt/<d>/...` topics in the directions below. `<d>` below = mqtt_username. **Full firmware guide with every payload: [DEVICE-API.md](DEVICE-API.md).**

| Topic | Dir | QoS / retain | Payload |
|---|---|---|---|
| `wt/<d>/status` | ESP → | 1, retained | `"online"` on connect. **Last will:** `"offline"`. |
| `wt/<d>/state` | ESP → | 0 | `{"st":"WORK","pump":1,"cm":62.4,"rssi":-61,"up":86400,"fw":"1.3","snd":1}`. Every 5 s, and at once on any change. Backend upserts `device_state`. |
| `wt/<d>/event` | ESP → | 1 | `{"t":"auto_cutoff","cm":24.8}`, `{"t":"pump","on":1,"src":"button"}`, `{"t":"reboot","reason":"power"}`, `{"t":"on_refused","why":"near"}` |
| `wt/<d>/cmd` | → ESP | 1 | `{"id":812,"c":"pump_on"}` (`pump_off`, `reboot`, `config_mode`, `ota_check`) |
| `wt/<d>/cmd/ack` | ESP → | 1 | `{"id":812,"ok":1}` or `{"id":812,"ok":0,"err":"near"}` |
| `wt/<d>/settings/set` | → ESP | 1, retained | `{"v":4,"cutoff_cm":35,"auto":1,"max_min":60}` |
| `wt/<d>/settings/ack` | ESP → | 1 | `{"v":4}` after saving to EEPROM |
| `wt/<d>/ota` | → ESP | 1 | `{"rid":3,"ver":"1.4","url":"https://<host>/fw/7.bin?t=...","sha256":"...","size":498123}` |
| `wt/<d>/ota/status` | ESP → | 1 | `{"rid":3,"s":"downloading"}` → `success` (sent after reboot with the new `fw`) or `failed` + `err` |

Retained `settings/set` means an ESP that was offline gets the latest settings as soon as it reconnects, even without the backend resending.

---

## 14. Screen → API map

| Screen | Calls |
|---|---|
| Login | 1.4, 1.5, then 2.6 |
| Sign up / Verify phone | 1.1, 1.2, 1.3 |
| Forgot password | 1.2, 1.3, 1.9 |
| Home (my tanks) | 3.1, 7.6, socket `device:subscribe`, `device:state` |
| Add tank (scan QR) | 3.2, 3.3 |
| Tank detail | 3.4, 5.1, socket `device:state`, `command:result`, `pump:run` |
| Tank settings | 4.1, 4.2, 3.5, 3.6, socket `settings:sync` |
| Timers | 6.1–6.4 |
| Share tank | 7.1–7.5 |
| Pump log | 8.1, 8.2 |
| Activity | 8.3 |
| Notifications | 9.1, 9.2 |
| Alert settings | 9.3, 9.4 |
| Profile | 2.1–2.10, 1.7, 1.8 |
| Admin: Dashboard | 10.1, 10.2, socket `admin:stats` |
| Admin: Devices | 10.3, 10.6–10.15 |
| Admin: Register device | 10.4, 10.5 |
| Admin: Users | 10.16–10.21 |
| Admin: Firmware & OTA | 10.22–10.30, socket `ota:progress` |
| Admin: Audit log | 10.31 |

## 15. Suggested test order (Postman / curl)

1. `POST /auth/register` → `POST /auth/otp/verify` → `POST /auth/login` → `GET /me`
2. Create the super_admin by SQL once, log in, `POST /admin/devices` with both ESP MACs → note `claimCode`
3. As the customer: `POST /devices/claim/check` → `POST /devices/claim` → `GET /devices`
4. `PATCH /devices/:id/settings {cutoffCm: 20}` → expect 422; `{cutoffCm: 35}` → expect `sync: "sending"`
5. With `mosquitto_sub -t 'wt/#'` open: `POST /devices/:id/pump {action:"on"}` → see `wt/<d>/cmd`; publish a fake ack with `mosquitto_pub`
6. Invite a second phone as `view`, accept, confirm `POST /pump` returns 403 for them
7. Timers, notifications, then admin users/OTA

## Decisions you may want to change

- **Level graphs** are not in the API because no level history is stored. The pump run-time chart (8.2) works without it. Turning on the optional `level_hourly` table would add `GET /devices/:id/levels?period=`.
- **QR format** `WT2:<token>` (was `WT1:<serial>:<claimCode>`): short text keeps the sticker QR small, and an opaque token means other scanners learn nothing about the device.
- **Removing a tank** (3.6) does not let the same QR work again; the admin issues a new claim code (10.8). This stops a former owner from re-claiming a sold tank.
