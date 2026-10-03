# Desktop register and hardware operations

## First-time register setup

1. Install and open **ALYQ POS**. Sign in as an admin or a role holding `registers.manage`.
2. Select the branch this till physically serves.
3. Open **Settings → Registers & devices**.
4. Enter a stable code such as `TILL-01` and a human name such as `Front Till`, then choose **Create & bind**.
5. The backend creates one branch-bound register and returns a one-time credential to that desktop. The credential is stored in Electron's per-user data, not in the package, browser storage, diagnostics or receipt.
6. Open a shift. The branch comes from the authenticated branch context and the register comes from the device binding; neither typed label is authority.

User, branch, register and shift remain four separate identities. Sharing a Windows profile between tills is not supported because it would share one installation binding and one IndexedDB outbox.

## Moving or retiring a till

- Rename is safe and preserves the register ID. Historical sales keep the register name frozen at sale time.
- Deactivate or reassign only after closing that register's shift and syncing/resolving every offline operation.
- The UI checks this desktop's live queue and the backend checks the register's last heartbeat counts and authoritative open shifts. Do not move an offline or powered-off till merely because its heartbeat is old; bring it online and verify zero pending/conflicts first.
- Deactivation blocks registered sale/shift RPCs. It does not erase historical sales, shifts, movements, audit or receipts.
- Reassignment is audited with old/new branch evidence. A desktop whose cached binding no longer matches the active branch is blocked until context is corrected.

## Scanner

The initial scanner path is a USB HID/keyboard wedge. Configure the scanner to send the barcode followed by Enter. ALYQ claims only a rapid burst of at least three characters. Ordinary input, textarea, select and contenteditable fields are excluded, so customer details, notes, discounts and settings are not cleared or submitted as scans.

The POS search field handles its own Enter event and resolves exact variant SKU/barcode first. For acceptance, scan `629ALYQ0142` and verify the cart/receipt says `Black / 42` and SKU `ALYQ-01-BLK-42`, not a sibling size.

## Thermal printer

1. Install the manufacturer's reviewed Windows driver and print its Windows test page.
2. Open **Settings → Desktop hardware**.
3. Select the printer, 80mm or 58mm paper, and 1–5 receipt copies. Enable direct/silent print only for a reviewed dedicated receipt driver.
4. Optionally enable auto-print after a completed sale. ALYQ deduplicates the automatic attempt per sale; a later manual reprint remains available.
5. Save, then submit an ALYQ test print.
6. “Submitted” means accepted by the Windows spooler only. Verify the paper physically. Health remains **Unknown** for paper, cover, connectivity and print completion because the current driver API cannot prove them.

If no desktop printer is configured, receipt actions use the existing safe web print-dialog fallback. A receipt failure never changes a completed sale. Fix the printer and reprint the historical sale; do not repeat payment or sale completion.

## Cash drawer

The supported initial mode is **Dedicated printer-driver job**. The Windows printer driver must map the dedicated tiny job to the attached drawer pulse. ALYQ does not execute PowerShell, shell commands or arbitrary raw bytes.

- Automatic drawer: enable only after a real driver test. It runs once after a completed sale containing paid cash. Visa/InstaPay-only sales do not trigger it.
- Manual drawer: requires `hardware.open_drawer`, a bound active register, an open shift on that register, and a reason. The backend authorizes/audits first; then the desktop submits the driver job.
- A submitted drawer job still reports physical state **Unknown**. If it fails, the sale stays completed and must not be repeated.

## Offline close/restart

Offline cash operations are committed atomically to IndexedDB with original user, branch, register, installation, exact variant, price evidence and idempotency key before the cart clears. The desktop close warning shows pending/conflicted counts and allows either:

- keep ALYQ open to sync now, or
- close safely and resume later.

Closing, restarting, catalog refresh and shell updates do not clear the durable business stores. The installer also preserves app data on uninstall by default. Use **Offline & Sync Center** after restart; do not manually clear the Electron profile.

## Cashier mode and safe shortcuts

On the POS route, the top-bar full-screen control enters/exits Cashier Mode. `F11` toggles it in the desktop shell and `Escape` exits. The renderer follows native full-screen change events so the recovery control remains accurate.

- `F2`: focus barcode/product search.
- `Ctrl+Alt+P`: focus the cash/payment input.
- `Ctrl+Alt+I`: open the existing Find Invoice / Return dialog.

Shortcuts only focus or open existing flows. They do not complete payment, hold/delete a cart, approve, return, reprint, or open the drawer.

## Sync Center and Health Center

Use the existing **Offline & Sync Center** to inspect pending, deferred, failed and conflicted operations, retry an eligible original-branch operation, or copy redacted evidence. Desktop does not have a second queue. Never re-enter a sale because sync is delayed.

Use the existing **System Health Center** for desktop version/build, backend/auth/realtime, IndexedDB compatibility, queue counts, branch/register status and conservative printer facts. **Unknown** is expected for physical printer and drawer state. Health refresh/repair does not delete durable pending operations.

## Troubleshooting

- **Desktop says register unavailable:** verify the active branch matches the bound register, the register is active, and the installation has not been reassigned. An authorized admin can inspect Registers & Devices; do not edit the local JSON file.
- **Cannot reassign/deactivate:** close the register's shift, reconnect that till, sync pending work, resolve conflicts, then wait for a zero-count heartbeat and retry.
- **Scan types but does not add:** verify the scanner sends Enter, the code is the exact active variant code, the active branch shelf is sellable, and focus is not in a normal form field.
- **Print submission fails:** verify the configured Windows driver name still exists, submit an ALYQ test print, then use historical reprint. Do not repeat the sale.
- **Drawer does not move:** verify driver mapping and cable physically. ALYQ can prove authorization/spool submission, not movement. Do not repeat the sale.
- **App will not close immediately:** read the close dialog. Pending work may be closed safely and resumed, but syncing first is preferred.

## Support bundle facts

The Health Center may include app version/build, OS/architecture, installation ID, register ID, queue counts, paper width, drawer mode and whether the configured driver is visible. It excludes auth tokens, cookies, register credential, service-role/database/signing keys, PINs, payment payloads and customer data.

Physical hardware testing must record scanner/printer/drawer models, Windows version and driver versions. Contract/emulator testing is not a physical acceptance result.
