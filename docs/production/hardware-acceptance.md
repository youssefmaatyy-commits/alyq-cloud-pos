# Real-store hardware acceptance

Status remains **REQUIRED** until signed by the store operator on the target Windows workstation.

Record workstation model/OS/build, ALYQ installer version/SHA, register, branch, driver versions, device models/serials, date, operator and evidence.

## Scanner

- Scan ALYQ-02 Black/42 ten times from valid POS focus; each resolves exact SKU/barcode once.
- Scan while customer, notes, quantity and manager PIN inputs are focused; no field corruption or unintended sale.
- Test rapid burst, unknown barcode, disabled and zero-stock variants.

## 80mm and 58mm printers

- Configure each width separately; print English, Arabic and mixed receipts.
- Verify logo, invoice, branch/register/cashier, date, numeric 42, letter XL, discounts, cash/card/split totals and footer.
- Reprint historical sale/return and confirm no stock/payment mutation.
- Cut/feed, margins, darkness and long receipt must be acceptable.

## Arabic driver

- Verify joined RTL glyphs, punctuation, mixed SKU/barcode direction, Arabic product/customer text and numerals on paper—not preview only.

## Cash drawer

- Cash sale may trigger configured drawer; card/InstaPay-only sale must not.
- Authorized manual open requires open shift, permission and reason; verify audit.
- Unauthorized open is denied. Disconnect drawer and confirm completed sale remains completed while failure is reported.

## Workstation/offline

- Install signed package as standard user and verify publisher/timestamp/checksum.
- Confirm single instance, persistent register binding and `userData` across restart/update/uninstall policy.
- Open shift; perform offline supported cash sale; restart; verify pending queue; reconnect and confirm one sale/payment/stock effect.
- Close and reconcile shift, then capture Health and Sync Center evidence.

Acceptance requires signatures from operator and release approver. Contract tests are not physical acceptance.