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

The app registers its provider token through `mobile_installation_register`. A production edge/worker service with protected service-role and FCM/APNs credentials may select active registrations, apply user/branch permission targeting, send privacy-safe payloads and process invalid-token feedback. Client applications must never receive those server credentials.

Provider credentials are intentionally absent, so `npm run mobile:build` does not prove provider delivery.

## Release checks

Run the complete repository validation, `npm run mobile:doctor`, Android Gradle build where the SDK exists, and Xcode archive on macOS. Inspect source and built artifacts for service-role keys, database passwords, PIN hashes, APNs/FCM server credentials, signing keys and test accounts. Test session expiry, device revocation, branch membership changes, offline write refusal, RTL/LTR and safe notification previews on real devices.
