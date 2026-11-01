# Water Level Platform: database design (v1)

PostgreSQL 14+ (tested on 16) on the Contabo VPS. This replaces Firebase completely, and FCM is used only for push notifications. The full SQL is in [schema.sql](schema.sql).

## Decisions from your answers

| Question | Decision |
|---|---|
| Device | One device = one tank = 2 ESPs (main relay + sender). Each board's MAC is stored in `device_boards`. |
| ESP data | No reading history is stored. `device_state` holds only the latest values, with one row per device that is overwritten. |
| Sharing | The owner shares a device with family members as `view` or `control`. |
| Roles | Only two account roles: `super_admin` (you, admin panel) and `user` (customer). Inside a device, access is only `owner`, `control` or `view`. No staff role. |
| Login | Phone + password (with SMS OTP), or a Google account. Email is optional. |
| Level | The ESP sends cm. Level % is calculated only if the user sets the tank height. The app shows both. |
| Time | Everything is stored in UTC. Each device has a time zone (default `Asia/Kolkata`) for display and timers. |
| MQTT | Mosquitto. Device login is checked against `devices.mqtt_username` + `secret_hash`. |

## Tables (21 tables + 2 views)

```
users ─┬─< refresh_tokens          (JWT refresh, logout from all devices)
       ├─< otp_codes               (SMS: verify phone, OTP login, reset password)
       ├─< push_tokens             (FCM tokens, one per phone)
       ├─< device_shares >─┐       (family access: view / control)
       ├─< alert_settings >┤       (per user, per device, per alert type)
       └─< notifications   │
                           │
devices ───────────────────┘  (owner_id → users, only ONE owner)
  ├─< device_boards        main + sender ESP, each with its MAC
  ├── device_settings      tank height, AUTO CUTOFF cm (min 25), auto mode     (1:1)
  ├─< settings_changes     history: cutoff 25 → 35 cm, who changed it, when ESP confirmed
  ├── device_state         live: online, status, pump, cm, %                  (1:1)
  ├─< device_invites       invite a family member by phone number
  ├─< pump_runs            ON→OFF cycles: when, how long, who/what started and stopped it
  ├─< device_events        faults, auto cutoff, reboot, online/offline, OTA result
  ├─< device_commands      every command sent from app/admin/timer + its ack
  ├─< timers               daily start/stop: ON 06:00 → OFF 06:30, chosen days
  └─< ota_rollout_devices >── ota_rollouts >── firmware_releases

audit_log                  every admin action (register device, block user, push OTA)
views: device_access (who may see/control a device), admin_stats (dashboard numbers)
```

## How the main flows use it

**Manufacturing (admin panel).** The super admin enters both MACs. The backend creates a `devices` row and generates a random device secret and claim code. Only their hashes are stored. The plain values are shown once: the secret is flashed into the ESP and the claim code is printed in the QR as `{serial, claimCode}`.

**Claiming (app).** The user scans the QR and the backend checks the claim code hash. If `owner_id` is still NULL, it sets the owner and `claimed_at`, and clears `claim_code_hash` so the code can't be reused. Because there is only one owner column, a second person can't claim the same device.

**Live data (MQTT → backend → Socket.IO).** Each message updates the single `device_state` row (an UPSERT) and is pushed to the app. Nothing is appended, so the database stays small however often the ESP sends. The Mosquitto last-will message sets `is_online = false`, and the backend writes an `offline` event.

**Pump control.** When a user presses ON in the app, the backend writes a `device_commands` row (`pending`), publishes it over MQTT, and marks it `acked` when the device replies. When the device reports pump ON, a `pump_runs` row is opened. When it reports OFF, that row is closed with `stop_reason`, and `duration_s` is calculated automatically. A unique index allows only one open run per device. A button press shows up as `start_source = 'button'` with no user.

**Auto cutoff per device (user sets it, minimum 25 cm).**
1. The user changes the cutoff from 25 to 35 cm in the app, and the backend runs `UPDATE device_settings SET cutoff_distance_cm = 35, updated_by = …`.
2. The database refuses anything below 25 cm, or any value not less than the tank height. A trigger bumps `version` and writes a row in `settings_changes` (`25 → 35`, who changed it).
3. The backend publishes to MQTT `wt/<device>/settings/set` with the payload `{"v": 3, "cutoff_cm": 35, "auto": true}` and sets `sent_at`.
4. The ESP saves the value in EEPROM, starts using it, and replies on `wt/<device>/settings/ack` with `{"v": 3}`.
5. The backend sets `applied_version = 3` and `applied_at`. The trigger marks that change as applied, and the app shows "Saved on device ✓". While `version > applied_version`, the app shows "Sending to device…". If the device was offline, the backend sends again when it comes back online.

The firmware needs one change for this: `NEAR_X10` is fixed at 250 today and must become a value saved in EEPROM. If it can't read a value, it falls back to 25 cm and never accepts less than 25.

**Level %.** `pct = (tank_height_cm − distance_cm) / (tank_height_cm − cutoff_distance_cm) × 100`, limited to 0–100. If `tank_height_cm` is NULL, the app shows only cm.

**Alerts.** When an event happens, the backend finds everyone in `device_access` with that alert enabled in `alert_settings` (no row means enabled), writes a `notifications` row, and sends FCM to their `push_tokens`. The cooldown index stops repeated "tank full" spam.

**OTA.** An admin uploads a `.bin`, and a `firmware_releases` row is created with its sha256. Pushing it creates an `ota_rollouts` row with one `ota_rollout_devices` row per device, and the status of each device is tracked up to `success` or `failed`. The current version per board is in `device_boards.fw_version`.

**Permissions check (every API call).**
`SELECT access FROM device_access WHERE device_id = $1 AND user_id = $2` returns `owner`, `control`, `view`, or no row (403). `super_admin` skips this check.

**Timers (daily start/stop).** Each timer has `start_time`, `stop_time`, the days it runs, and an optional "only if below X%" rule. A device can have several timers, for example a morning one and an evening one. Every minute, the backend finds timers whose start or stop time is now, sends `pump_on` or `pump_off`, and records it in `pump_runs` (`start_source = 'timer'`, `timer_id`). If the tank fills before the stop time, the ESP's auto cutoff stops the pump first, and `stop_reason` is `auto_cutoff`. A stop time earlier than the start time means the timer ends the next day (23:30 → 00:15).

## Size estimate

There is no time-series data, so even 10,000 devices stay under a few hundred MB. The tables that grow are `pump_runs`, `device_events`, `device_commands` and `notifications`. Delete rows older than about 1 year from `device_commands` and `notifications` with a nightly job.

## Not included (easy to add later)

- **Level graphs (day/week/month).** These need history, which you chose not to store. An optional `level_hourly` table is at the end of schema.sql, commented out. It would hold only 24 rows per device per day.
- **Payments/subscriptions** and **multiple tanks per device.**

## Security notes

- Rotate or delete the old Firebase database secret once the new system is live, because it is inside the current firmware `.bin`.
- Make the backend's DB user the owner of these tables, but don't make it a PostgreSQL superuser. Don't open port 5432 to the internet on Contabo. The backend connects on localhost.
