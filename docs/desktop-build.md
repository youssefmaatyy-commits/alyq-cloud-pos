# ALYQ POS desktop build and release

## Prerequisites

- Node.js 22.x and npm 10.x
- Windows x64 for the final installer acceptance run
- Network access to the npm registry and Electron binary mirror
- For production: a Windows code-signing certificate supplied to CI through its secret store (never committed)

Install exactly the locked dependency graph:

```bash
npm ci
```

## Development

```bash
npm run desktop:dev
```

The runner starts Vite on `127.0.0.1`, waits for it, and then starts Electron with that exact local origin. A non-local `ALYQ_DESKTOP_DEV_URL` is refused by the shell.

## Build and package

```bash
# Shared web/desktop renderer
npm run desktop:build

# Unpacked application, useful for smoke checks
npm run desktop:package:dir

# Windows x64 unpacked application (can be attempted on CI hosts that support it)
npm run desktop:package:win:unpacked

# Windows x64 NSIS installer
npm run desktop:package:win
```

Outputs go to ignored `release/`. Never commit the directory or an installer.

For an attributable build, set `ALYQ_BUILD_SHA` to the source commit before packaging. CI should fail if it is empty for a release build.

## Required release checks

1. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run db:check`, `npm run build`.
2. Build the Windows x64 installer from a clean checkout and pinned lockfile.
3. Sign the `.exe` and verify the Authenticode signature and timestamp on a separate Windows machine.
4. Install as a standard user; verify Start Menu/Desktop shortcuts and one-running-instance behavior.
5. Verify login, branch, register binding, opening/closing a shift, exact-variant Black/42 scan, one cash sale, one non-cash sale, offline close/restart/sync, 58mm and 80mm print submission, reprint, drawer policy, Health Center facts and uninstall/reinstall persistence.
6. Confirm that no service-role key, database password, manager PIN hash, register credential, signing key or user profile data is present in the package contents or logs.
7. Record real printer/scanner/drawer model and driver versions. Do not convert emulator/contract checks into a physical-hardware claim.

## Program updates (manual-only until Windows signing is available)

System → Program updates checks the pinned public GitHub Releases endpoint for the latest valid SemVer tag. It never downloads or executes a binary. If a newer release is found, the user may open the repository's official Releases page and download the installer manually. The panel does not display fabricated transfer progress or offer an automatic install/restart button.

There is no Authenticode certificate in this project. Do not describe the installer as signed or Windows-trusted. Windows may show SmartScreen/unknown-publisher warnings. Users must verify they are on `github.com/youssefmaatyy-commits/alyq-cloud-pos/releases` and install only after reviewing the release. No silent update runs, and the user chooses when to close/reinstall. Never publish a release without a new, unique SemVer version and rollback notes.

`electron-builder` may read signing inputs from protected CI environment variables when a certificate becomes available. Do not add signing values to `.env`, `package.json`, workflow logs or repository files. A secure automatic updater remains disabled until signed artifacts/metadata, a trusted HTTPS feed, integrity verification and rollback procedures are available.

## Upgrade/data-preservation boundary

This preview keeps `appId: eg.alyq.pos`, Electron's default per-user `userData` location, `desktop-config.v1.json`, and NSIS `deleteAppDataOnUninstall: false`; the version change alone does not migrate or erase user data. These code/config invariants are covered by automated checks. **An install-over-existing-version test has not been run on a physical Windows machine**, so do not promise upgrade compatibility until the standard-user Windows acceptance procedure above passes. Keep the previous installer available for rollback. Local offline data and pending invoices stay governed by their existing durable storage/recovery implementation; do not uninstall or clear app data as part of a manual upgrade.
