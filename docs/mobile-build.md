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

Before production:

1. Set approved application/version codes.
2. Configure Firebase for package `eg.alyq.management`; supply `google-services.json` through protected CI, never Git.
3. Configure `mobile.alyq.eg` Digital Asset Links for verified links.
4. Store the upload/signing keystore outside the repository and use Play App Signing.
5. Build/test a signed AAB, notification channels, denied-permission behavior, token rotation, logout, and branch-revoked deep links on supported Android versions.

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

`supabase/functions/alyq-push` sends bounded batches through FCM HTTP v1 and APNs. Invoke it on a protected schedule with `Authorization: Bearer <PUSH_DISPATCH_SECRET>`. The dedicated dispatch secret authenticates invocation only; `SUPABASE_SERVICE_ROLE_KEY` is internal database authority and must never be sent by a scheduler or other caller. Deploy this function with gateway JWT verification disabled (for example, the Supabase deployment option `--no-verify-jwt`) because the function performs its own exact dispatch-secret check. Do not expose either secret to a browser or mobile client. The function reports only aggregate counts and never logs tokens, notification copy, provider response bodies, recipients, or credentials.

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

Native protected configuration remains external:

- Android `android/app/google-services.json` is ignored and must be injected by protected CI/local setup.
- Android upload/signing keystores are ignored and remain in protected CI/Play App Signing.
- iOS APNs `.p8` keys, signing certificates and provisioning profiles remain in protected CI/Keychain.
- The iOS Push Notifications capability and `aps-environment` entitlement must be enabled in the real App ID/Xcode signing configuration. This repository does not fabricate an entitlement or provisioning value.

Provider credentials are intentionally absent, so `npm run mobile:build` does not prove provider delivery. Validate FCM/APNs delivery, token rotation, invalid-token feedback, foreground/background/killed-state opens, denied permission, multiple devices, local/global logout, branch revocation, and app updates on signed physical-device builds.

## Release checks

Run the complete repository validation, `npm run mobile:doctor`, Android Gradle build where the SDK exists, and Xcode archive on macOS. Inspect source and built artifacts for service-role keys, database passwords, PIN hashes, APNs/FCM server credentials, signing keys and test accounts. Test session expiry, device revocation, branch membership changes, offline write refusal, RTL/LTR and safe notification previews on real devices.
