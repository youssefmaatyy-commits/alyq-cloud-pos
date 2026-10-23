# ALYQ Mobile development and release

## Prerequisites

- Node.js 22.12+ and npm
- Android Studio/JDK/Android SDK for Android builds
- macOS with current Xcode for iOS builds
- Production signing identities held in protected CI/store systems

```bash
npm ci
npm run mobile:build
```

`mobile:build` builds the same Vite application and runs `cap sync` for both native projects. Web output remains ignored; native source projects are committed.

## Local web/mobile UI

```bash
npm run dev
# Open /#/mobile and sign in with an existing ALYQ account.
```

Use responsive widths 360, 390 and 430 pixels in English and Arabic. The web route is useful for UI and service testing but does not prove native push or secure platform behavior.

## Android

```bash
npm run mobile:build
npm run mobile:android
# or: cd android && ./gradlew assembleDebug
```

### Package & Upgrade Identity
- **Package ID (`applicationId`):** `eg.alyq.management`
- **App Name:** `ALYQ POS`
- **Version:** `versionCode 2` / `versionName "2.0.0"` (upgrades cleanly over `versionCode 1` when signed with the same certificate).
- **External Release Signing:** `android/app/build.gradle` reads `ALYQ_KEYSTORE_PATH`, `ALYQ_KEYSTORE_PASSWORD`, `ALYQ_KEY_ALIAS`, and `ALYQ_KEY_PASSWORD` from environment variables at build time. No keystore or secret is ever stored in the repository or inside the web bundle.

### Hardware & Native Capabilities on Android
1. **Camera Barcode Scanning (`android.permission.CAMERA`):**
   - Declared in `android/app/src/main/AndroidManifest.xml` with optional camera hardware features (`android:required="false"`).
   - Capacitor's `BridgeWebChromeClient.onPermissionRequest` bridges WebView `getUserMedia` video requests to Android's native runtime permission prompt.
   - `src/modules/pos/services/cameraBarcodeScanner.ts` uses hardware-accelerated `window.BarcodeDetector` when supported by the device's Android System WebView and automatically falls back to a built-in pure-TypeScript 1D Canvas Scanline Decoder (`Code 128` Subset B/C + `EAN-13`/`UPC-A`).
2. **Receipt Printing (`window.ALYQAndroidPrint`):**
   - Because `window.print()` is a no-op inside an embedded Android `WebView`, `MainActivity.java` registers a narrow receipt-only `@JavascriptInterface` (`ALYQAndroidPrint`) that loads static receipt HTML (with JavaScript disabled) into an offscreen `WebView` and invokes Android's native `PrintManager` (`com.android.printspooler`) via `createPrintDocumentAdapter`.
   - Supports Wi-Fi/Network printers, Mopria printers, PDF export, and Bluetooth thermal printers that provide an Android Print Service plugin (e.g., RawBT, Star, Epson, Sunmi).
   - **Direct Raw Bluetooth ESC/POS socket printing** (without an Android Print Service) and **hardware RJ11 cash drawer kick** require a dedicated Native Bluetooth/Serial ESC/POS Capacitor plugin and Android 12+ `BLUETOOTH_CONNECT`/`BLUETOOTH_SCAN` permissions.

## iOS

```bash
npm run mobile:build
npm run mobile:ios
```

A native iOS build requires macOS/Xcode. Configure the App ID, provisioning profile, signing team, Push Notifications entitlement, APNs key in the provider backend, and Associated Domains for `applinks:mobile.alyq.eg`. Validate archive/export and TestFlight on macOS. No signing material belongs in this repository.

## Deep links

Supported intent paths:

- `alyq://mobile/orders/<id>`
- `alyq://mobile/invoices/<id>`
- `alyq://mobile/approvals/<id>`
- `alyq://mobile/inventory/<id>`
- matching verified HTTPS paths under `https://mobile.alyq.eg/mobile/...`

A valid path still requires a signed-in user, required permission and successful active-branch backend read.

## Push backend

Migration `0092_mobile_push_and_notification_center.sql` owns the durable outbox, current-recipient resolution, per-installation delivery state, immutable attempt evidence, retry/dead-letter behavior, invalid-token deactivation, and server-backed inbox/read state. Mobile registers/rotates a token through `mobile_installation_register_v2`; registration-time branch data is never final authorization.

`supabase/functions/alyq-push` sends bounded batches through FCM HTTP v1, APNs, and standards-based Web Push. Invoke it on a protected schedule with `Authorization: Bearer <PUSH_DISPATCH_SECRET>`. The dedicated dispatch secret authenticates invocation only; `SUPABASE_SERVICE_ROLE_KEY` is internal database authority and must never be sent by a scheduler or other caller. Deploy this function with gateway JWT verification disabled (for example, the Supabase deployment option `--no-verify-jwt`) because the function performs its own exact dispatch-secret check. Do not expose either secret to a browser or mobile client. The function reports only aggregate counts and never logs tokens, notification copy, provider response bodies, recipients, subscription keys, or credentials.

Protected Edge Function secret names (values stay in Supabase secret custody):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PUSH_DISPATCH_SECRET`
- `FCM_PROJECT_ID`
- `FCM_CLIENT_EMAIL`
- `FCM_PRIVATE_KEY`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_PRIVATE_KEY`
- `APNS_TOPIC`
- `APNS_ENVIRONMENT` (`production` or `sandbox`)
- `WEB_PUSH_VAPID_PUBLIC_KEY` (public P-256 application-server key)
- `WEB_PUSH_VAPID_PRIVATE_KEY` (server-only)
- `WEB_PUSH_SUBJECT` (`mailto:` or HTTPS operator contact)

For migration 0099, follow [the notification rollout and rollback runbook](production/notification-0099-rollout.md). Its preferred Staging Vault path generates the dispatcher bearer inside PostgreSQL and the VAPID pair inside the authenticated worker, so neither private value is printed in a terminal or deployment log. Existing Production Edge-secret configuration remains supported and must not be rotated incidentally.

The browser may obtain the **public** VAPID key either from the controlled Web build environment as `WEB_PUSH_VAPID_PUBLIC_KEY` or from the authenticated `notification_web_push_public_config` RPC. Put the same public value, private value, and subject in protected server custody when using Edge secrets. Never place the private key or subject in any `VITE_*` variable, repository file, command transcript, or browser-visible configuration.

## iPhone/iPad Home Screen Web Push

Safari Web Push on supported iOS/iPadOS versions requires the installed Home Screen web app and does not require Apple Developer Program membership. Open ALYQ in Safari, use **Share → Add to Home Screen**, launch ALYQ from its icon, sign in, open **Notifications**, and tap **Enable notifications**. ALYQ never prompts on page load. A normal Safari tab shows installation guidance instead of requesting permission.

The service worker displays only a generic bilingual ALYQ alert. Its encrypted payload and click handoff carry only an opaque `notification_id`; after Auth and branch restoration, the app calls the existing server route resolver and falls back to Notification Center for stale or unauthorized destinations. Migration `0094_web_push_subscriptions.sql` adds protected subscription custody and extends the existing delivery state machine—it does not create another outbox or inbox.

Native protected configuration remains external:

- Android `android/app/google-services.json` is ignored and must be injected by protected CI/local setup.
- Android upload/signing keystores are ignored and remain in protected CI/Play App Signing.
- iOS APNs `.p8` keys, signing certificates and provisioning profiles remain in protected CI/Keychain.
- The iOS Push Notifications capability and `aps-environment` entitlement must be enabled in the real App ID/Xcode signing configuration. This repository does not fabricate an entitlement or provisioning value.

Provider credentials are intentionally absent, so `npm run mobile:build` does not prove provider delivery. Validate FCM/APNs delivery, token rotation, invalid-token feedback, foreground/background/killed-state opens, denied permission, multiple devices, local/global logout, branch revocation, and app updates on signed physical-device builds.

## Release checks

Run the complete repository validation, `npm run mobile:doctor`, Android Gradle build where the SDK exists, and Xcode archive on macOS. Inspect source and built artifacts for service-role keys, database passwords, PIN hashes, APNs/FCM server credentials, signing keys and test accounts. Test session expiry, device revocation, branch membership changes, offline write refusal, RTL/LTR and safe notification previews on real devices.
