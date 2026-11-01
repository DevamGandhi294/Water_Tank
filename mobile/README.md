# Water Tank app (Flutter)

Customer app for Android and iOS, light theme, built from the approved mockup (`docs/ui-mockup.html`).

Screens: login, sign up, reset password (via support for now), my tanks (live), add tank by QR or code, tank live view with pump switch, tank settings (auto cutoff ≥ 25 cm with "Saved on device ✓", height, capacity, auto mode, max run, rename, remove), timers, sharing with family (view / control), pump log with run-time chart, activity, alerts list, per-tank alert settings with quiet hours, profile (name/email, password, logged-in phones, log out everywhere, delete account).

It talks to the backend REST API (`docs/API.md`) and gets live updates over Socket.IO.

## Build and run (Docker, from WSL)

All Flutter commands run in the `ghcr.io/cirruslabs/flutter:stable` image (Flutter 3.44 / Dart 3.12), so nothing is installed on Windows. From the repo root:

```bash
alias fl='docker run --rm -v $PWD/mobile:/app -v wt_pub_cache:/root/.pub-cache -v wt_gradle_cache:/root/.gradle -w /app ghcr.io/cirruslabs/flutter:stable'
fl flutter pub get
fl flutter analyze
fl flutter test
fl flutter build apk --release                      # → mobile/build/app/outputs/flutter-apk/app-release.apk
```

The app uses `https://watertank.ecobridgers.com` by default. To point a build at another server:

```bash
fl flutter build apk --release --dart-define=API_BASE=http://192.168.1.10:3000
```

(Debug builds allow plain `http://`; release builds need `https://`.)

Install the APK on a phone: copy `app-release.apk` over, or with USB debugging `adb install -r mobile/build/app/outputs/flutter-apk/app-release.apk` (adb from Windows or WSL).

The release APK is signed with the debug key, which is fine for testing. For the Play Store, create an upload key and a `android/key.properties` (both git-ignored) and switch `signingConfig` in `android/app/build.gradle.kts`.

iOS builds need a Mac with Xcode (`flutter build ipa`); the code and `ios/` project are ready, including the camera permission text.

## Structure

```
lib/
  config.dart          API_BASE (dart-define)
  theme.dart           light theme colors from the mockup
  api/                 HTTP client (token refresh) and JSON models
  state/session.dart   login, tokens in secure storage
  state/live.dart      Socket.IO: device:state, command:result, settings:sync, notifications…
  screens/             one file per screen group
  widgets/             tank drawing, pills, shared bits
```

## Push notifications (later)

Not wired in yet because it needs your Firebase project files. When ready: add `firebase_core` + `firebase_messaging`, put `google-services.json` in `android/app/`, get the FCM token at startup and send it with `POST /api/v1/me/push-tokens {fcmToken, platform}`; remove it on logout with `DELETE /api/v1/me/push-tokens/<token>`. The backend side is done (see DEPLOY.md, "Push notifications").
