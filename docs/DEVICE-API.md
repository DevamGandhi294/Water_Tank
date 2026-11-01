# Water Tank: device (IoT) API for the ESP firmware

Everything the **main relay board** (ESP8266) needs to talk to the new server. This replaces Firebase completely. The sender (ultrasonic) board keeps talking only to the main board over HC-12, as today.

The firmware only uses **MQTT** for live data and control, plus **two HTTPS downloads** for OTA. The phone app and admin panel never talk to the ESP directly. They go through the backend, which turns their requests into the MQTT messages below and pushes the ESP's answers to the app over Socket.IO.

```
ESP main board ──MQTT/TLS 8883──► Mosquitto ◄──► backend ──Socket.IO──► app / admin panel
       │                                           │
       └──────HTTPS GET firmware .bin──────────────┘
```

All examples were checked against the running backend (`backend/test/api.test.js` plays the ESP with exactly these messages).

---

## 1. Connection

| Setting | Value |
|---|---|
| Broker | `watertank.ecobridgers.com` |
| Port | **8883** (MQTT over TLS 1.2). Port 1883 is open only inside the server, not to the internet. |
| TLS | Let's Encrypt certificate for `watertank.ecobridgers.com`. On ESP8266 use `BearSSL::WiFiClientSecure` with the ISRG Root X1 CA (`setTrustAnchors`), or `setInsecure()` while testing. Set the clock with NTP first, otherwise certificate checks fail. |
| MQTT version | 3.1.1 |
| Client ID | the **main board MAC**, 12 lowercase hex characters, no colons. Example: MAC `A4:CF:12:9B:42:10` → `a4cf129b4210` |
| Username | the same value: `a4cf129b4210` |
| Password | any **non-empty** text. The server ignores it (login is by registered MAC only). Use the MAC again: `a4cf129b4210` |
| Keep alive | 60 s (max 300) |
| Clean session | `true` |
| Last will | topic `wt/<d>/status`, payload `offline`, QoS 1, **retained** |

`<d>` in every topic below is that same 12-character MAC string.

**Who may connect.** Mosquitto asks the backend about every login. The login is accepted only if the admin registered this main board MAC in the admin panel ("Register device") and the device is not disabled. Otherwise the broker answers *Not authorized* (CONNACK return code 5). A disabled device is refused within about 2 seconds of being disabled.

**Which topics.** A board may only use its own `wt/<d>/...` topics, and only in the direction shown in the table. Anything else is dropped silently by the broker (MQTT 3.1.1 has no error for that).

> Security note: a MAC is not a secret. Someone who knows a board's MAC could connect as that tank. TLS still stops anyone from reading or changing the traffic, and the admin can disable a device at once. A per-device key can be added later without changing any topic.

### Topic summary

| Topic | Direction | QoS | Retain | When |
|---|---|---|---|---|
| `wt/<d>/status` | ESP → server | 1 | yes | `online` right after connecting; the last will sends `offline` |
| `wt/<d>/state` | ESP → server | 0 | no | every 5 s, and at once on any change |
| `wt/<d>/event` | ESP → server | 1 | no | when something happens (cutoff, button, reboot, refused ON) |
| `wt/<d>/cmd` | server → ESP | 1 | no | pump on/off, reboot, config mode, OTA check |
| `wt/<d>/cmd/ack` | ESP → server | 1 | no | answer to every `cmd` |
| `wt/<d>/settings/set` | server → ESP | 1 | **yes** | cutoff / auto mode / max run time changed |
| `wt/<d>/settings/ack` | ESP → server | 1 | no | after the settings are saved in EEPROM |
| `wt/<d>/ota` | server → ESP | 1 | no | admin pushed a firmware update |
| `wt/<d>/ota/status` | ESP → server | 1 | no | OTA progress and result |

The ESP subscribes to exactly three topics: `wt/<d>/cmd`, `wt/<d>/settings/set`, `wt/<d>/ota` (QoS 1).

### Connect sequence

1. Connect with the settings above (last will set).
2. Subscribe to `wt/<d>/cmd`, `wt/<d>/settings/set`, `wt/<d>/ota`.
3. Publish `online` to `wt/<d>/status` (QoS 1, retained).
4. The broker immediately delivers the retained `settings/set`. Apply it and send `settings/ack` (section 4).
5. Publish one `state` message straight away, then every 5 s.

If the connection drops, reconnect with a back-off (for example 2 s, 4 s, 8 s … up to 60 s) and repeat the whole sequence. The relay, buttons and the local auto cutoff must keep working without Wi-Fi, exactly like today.

---

## 2. Status and live state (ESP → server)

### `wt/<d>/status`

Plain text, not JSON.

```
online
```
Sent by the ESP after connecting (QoS 1, retained). The broker sends the last will `offline` (QoS 1, retained) when the ESP disappears without disconnecting. The ESP can also publish `offline` itself before a planned restart.

If the server hears nothing from a board for 60 s, it marks it offline even without the last will.

### `wt/<d>/state`

Every 5 seconds, and **at once** whenever the pump, status or distance changes.

```json
{"st":"WORK","pump":1,"cm":62.4,"rssi":-61,"up":86400,"fw":"1.3","snd":1}
```

| Field | Type | Meaning |
|---|---|---|
| `st` | string | `WORK`, `DOWN` (ultrasonic no echo), `FAULT` (sender board not heard), `CONFIG` (Wi-Fi setup portal open), `OTA` (installing update). Same priority as the current firmware: OTA, CONFIG, FAULT, DOWN, WORK. The old texts `CONFIG MAIN` and `OTA UPDATE` are also accepted. |
| `pump` | 0 / 1 | relay state right now |
| `cm` | number or `null` | distance from the sensor to the water, 0.1 cm precision. Send `null` (or `-1`) when there is no valid reading. |
| `rssi` | integer | Wi-Fi signal in dBm |
| `up` | integer | seconds since boot |
| `fw` | string | firmware version running, e.g. `"1.4"` |
| `snd` | 0 / 1 | 1 if a frame from the sender board arrived recently |

Every field is optional; send what you have. The server computes the level % itself from the user's tank height and cutoff, so the ESP never needs the tank height.

What the server does with it: updates the live state the app shows (at most one update per second goes to the phones), opens and closes pump run records when `pump` changes, raises a "sensor fault" alert when `st` becomes `FAULT` or `DOWN`, clears it when it goes back to `WORK`, raises "tank full" / "tank low" alerts when the level crosses each user's threshold, and records the firmware version.

---

## 3. Events (ESP → server)

`wt/<d>/event`, QoS 1. Send one message per event. These make the history readable ("stopped by auto cutoff", "button on device"), so please send them even though `state` also shows the pump change.

**Auto cutoff stopped the pump** (water reached the cutoff distance):
```json
{"t":"auto_cutoff","cm":24.8}
```

**Pump switched by a physical button** (or by the ESP's own logic):
```json
{"t":"pump","on":1,"src":"button"}
{"t":"pump","on":0,"src":"button"}
```
`src` is one of `button`, `auto`. Don't send this event for switches the server asked for with `cmd`; the server already knows those.

**Board restarted** (send once after every boot, after connecting):
```json
{"t":"reboot","reason":"power"}
```
`reason`: `power`, `watchdog`, `ota`, `command`, `exception`, `unknown`. ESP8266: map `ESP.getResetInfoPtr()->reason` (0 = power, 1/2/3 = watchdog/exception, 4 = soft restart → `command` or `ota`).

**Pump ON refused locally** (button pressed or command received while the tank is full, or while the sensor is faulty and `SAFETY_NEED_SENSOR` is on):
```json
{"t":"on_refused","why":"near"}
{"t":"on_refused","why":"fault"}
```

**Config mode opened** (Wi-Fi setup portal):
```json
{"t":"config_mode"}
```

---

## 4. Settings: auto cutoff (server → ESP, ESP → server)

The owner sets the cutoff distance in the app (minimum 25 cm). The server sends it on a **retained** topic, so a board that was offline gets the latest settings the moment it connects.

### `wt/<d>/settings/set` (server → ESP, QoS 1, retained)

```json
{"v":4,"cutoff_cm":35,"auto":1,"max_min":60}
```

| Field | Meaning |
|---|---|
| `v` | settings version. Goes up by 1 on every change. |
| `cutoff_cm` | auto cutoff: relay OFF when the distance is **at or below** this many cm. Always 25 to 300. This replaces the fixed `NEAR_X10 = 250`. |
| `auto` | 1 = safety on: refuse pump ON (and switch it off) while `st` is `FAULT` or `DOWN`. 0 = off. This replaces the fixed `SAFETY_NEED_SENSOR`. |
| `max_min` | maximum pump run in minutes; 0 = no limit. The server also enforces this, so the ESP may ignore it, but stopping locally is safer when Wi-Fi is down. |

What the ESP must do:
1. If `v` is the same as the version already saved, just send the ack again (the same message can arrive twice, for example once retained and once re-sent after a reconnect).
2. Check the values: if `cutoff_cm` is missing or below 25, use 25. **Never accept less than 25 cm.**
3. Save `v`, `cutoff_cm`, `auto`, `max_min` in EEPROM and start using them at once.
4. Reply with the version.

An empty retained message on this topic means the device was deleted from the server; ignore it.

At first boot (nothing in EEPROM) use cutoff 25 cm, auto 1, max 0, version 0 until the first `settings/set` arrives.

### `wt/<d>/settings/ack` (ESP → server, QoS 1)

```json
{"v":4}
```
Send it only after the values are saved. The app then switches from "Sending to device…" to "Saved on device ✓".

---

## 5. Commands (server → ESP, ESP → server)

### `wt/<d>/cmd` (server → ESP, QoS 1)

```json
{"id":812,"c":"pump_on"}
```

| `c` | What the ESP does |
|---|---|
| `pump_on` | relay ON, unless the tank is full (distance ≤ cutoff) or the sensor is faulty while `auto` = 1. Then refuse. |
| `pump_off` | relay OFF |
| `reboot` | ack first, then restart after about 1 s |
| `config_mode` | ack, then open the Wi-Fi setup portal (same as the 5-press reset today) |
| `ota_check` | ack, then check `/ota/version.json` at once (section 6.2) |
| `apply_settings` | ack; the server also re-sends `settings/set`. Nothing else to do. |

### `wt/<d>/cmd/ack` (ESP → server, QoS 1)

Answer **every** command with its `id`, within 30 seconds (the server marks it expired after that).

```json
{"id":812,"ok":1}
```
Refused:
```json
{"id":812,"ok":0,"err":"near"}
```

| `err` | Meaning |
|---|---|
| `near` | tank already full (distance ≤ cutoff) |
| `fault` | sensor not working and `auto` = 1 |
| `busy` | OTA or config mode running |
| `unknown_cmd` | the firmware does not know this `c` |

After a successful `pump_on` / `pump_off`, also publish a `state` message at once with the new `pump` value. The app's button waits for the ack and then for the state.

Commands are not retained and not queued: if the board is offline, the app refuses the action before anything is sent.

---

## 6. OTA firmware update

### 6.1 New way: the admin pushes an update

The admin uploads a `.bin` in the admin panel and pushes it to some or all devices. Online boards get this at once; offline boards get it when they reconnect.

**`wt/<d>/ota` (server → ESP, QoS 1)**
```json
{"rid":3,"ver":"1.4","url":"https://watertank.ecobridgers.com/fw/7.bin?t=eyJhbGciOi...","sha256":"9f2c...e1","size":498123}
```

| Field | Meaning |
|---|---|
| `rid` | rollout id; send it back in every `ota/status` |
| `ver` | version being installed |
| `url` | HTTPS download link, valid for **10 minutes** |
| `sha256` | SHA-256 of the file (hex) |
| `size` | file size in bytes |

**`GET <url>`** returns the binary (`application/octet-stream`) with `Content-Length` and an `x-MD5` header, which `ESP8266httpUpdate` checks automatically. An expired or wrong link returns `403`.

**`wt/<d>/ota/status` (ESP → server, QoS 1)**

```json
{"rid":3,"s":"downloading"}
```
just before starting the download.

```json
{"rid":3,"s":"failed","err":"HTTP 403"}
```
if anything goes wrong (download error, wrong size, not enough space). `err` is a short text.

```json
{"rid":3,"s":"success"}
```
after the reboot, once connected again and running the new version. Keep `rid` in EEPROM/RTC memory across the reboot to send this. If you can't, it's fine: as soon as the board reports the new version in `state.fw`, the server marks the rollout as done.

If `ver` equals the running version, reply `{"rid":3,"s":"success"}` without downloading.

### 6.2 Old way: version.json (kept for v1.2 / v1.3 boards)

These still work, so boards in the field keep updating while they are moved to MQTT:

`GET https://watertank.ecobridgers.com/ota/version.json`
```json
{ "version": "1.4", "url": "https://watertank.ecobridgers.com/ota/firmware/main_relay_1.4.bin" }
```
`version` is the release the admin marked **stable** for the main board. `404` until a stable release exists.

`GET https://watertank.ecobridgers.com/ota/firmware/main_relay_1.4.bin` returns that file. No token needed.

New MQTT firmware can keep this check (at boot and on `ota_check`) as a fallback.

---

## 7. Full session example

Device `A4:CF:12:9B:42:10`, owner sets cutoff 35 cm, presses ON in the app, water reaches the cutoff.

```
ESP  CONNECT  clientId=a4cf129b4210 user=a4cf129b4210 pass=a4cf129b4210
              will: wt/a4cf129b4210/status "offline" qos1 retain
ESP  SUB      wt/a4cf129b4210/cmd, wt/a4cf129b4210/settings/set, wt/a4cf129b4210/ota
ESP  PUB      wt/a4cf129b4210/status        online                                    (retain)
SRV  PUB      wt/a4cf129b4210/settings/set  {"v":1,"cutoff_cm":25,"auto":1,"max_min":0} (retained copy)
ESP  PUB      wt/a4cf129b4210/settings/ack  {"v":1}
ESP  PUB      wt/a4cf129b4210/event         {"t":"reboot","reason":"power"}
ESP  PUB      wt/a4cf129b4210/state         {"st":"WORK","pump":0,"cm":120.0,"rssi":-58,"up":12,"fw":"1.4","snd":1}
      … state every 5 s …
SRV  PUB      wt/a4cf129b4210/settings/set  {"v":2,"cutoff_cm":35,"auto":1,"max_min":60}
ESP  PUB      wt/a4cf129b4210/settings/ack  {"v":2}
SRV  PUB      wt/a4cf129b4210/cmd           {"id":812,"c":"pump_on"}
ESP  PUB      wt/a4cf129b4210/cmd/ack       {"id":812,"ok":1}
ESP  PUB      wt/a4cf129b4210/state         {"st":"WORK","pump":1,"cm":119.8,...}
      … water rises …
ESP  PUB      wt/a4cf129b4210/event         {"t":"auto_cutoff","cm":34.9}
ESP  PUB      wt/a4cf129b4210/state         {"st":"WORK","pump":0,"cm":34.9,...}
      … power cut …
BRK  PUB      wt/a4cf129b4210/status        offline                                   (last will)
```

---

## 8. Testing without hardware

On the VPS (port 1883 is reachable only from the server itself), with a registered MAC `a4cf129b4210`:

```bash
# watch everything for that board
mosquitto_sub -h 127.0.0.1 -p 1883 -u a4cf129b4210 -P x -i a4cf129b4210-sub -t 'wt/a4cf129b4210/#' -v
```
That only shows the topics the device may read. To watch everything, use the backend login from `.env`:
```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -u wt-backend -P "$MQTT_BACKEND_PASSWORD" -t 'wt/#' -v
```
Pretend to be the board:
```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -u a4cf129b4210 -P x -i a4cf129b4210 -t wt/a4cf129b4210/status -m online -r -q 1
mosquitto_pub -h 127.0.0.1 -p 1883 -u a4cf129b4210 -P x -i a4cf129b4210 -t wt/a4cf129b4210/state \
  -m '{"st":"WORK","pump":0,"cm":80.5,"rssi":-60,"up":100,"fw":"1.4","snd":1}'
```
Over TLS from your PC: add `-p 8883 --capath /etc/ssl/certs` and use `-h watertank.ecobridgers.com`.

Locally, `npm run fake-device -- <MAC>` in `backend/` runs a simulated board against the Docker dev stack (it answers commands and settings like real firmware).

---

## 9. Firmware changes needed (summary)

1. Replace Firebase reads/writes with the MQTT topics above (PubSubClient or similar, with BearSSL).
2. Client ID and username = main board MAC (lowercase, no colons); password = the same text.
3. `NEAR_X10` and `SAFETY_NEED_SENSOR` come from `settings/set` and are saved in EEPROM, never below 25 cm.
4. Send `state` every 5 s and on change; send the events in section 3.
5. Handle `cmd` and always ack with the `id`.
6. Handle `ota` (download the signed URL, report progress). Keep the old `version.json` check as a fallback.
7. Keep the relay, buttons, buzzer and local cutoff working without Wi-Fi.
8. Remove the Firebase database secret from the firmware and rotate it in Firebase once all boards are moved.
