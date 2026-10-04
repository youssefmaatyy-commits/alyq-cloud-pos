# ALYQ Mobile operations

## Sign-in and branch context

Use an existing ALYQ staff account. The app shows only memberships returned by `get_my_branches`; switching calls the authoritative audited branch RPC, refreshes identity/permissions and remounts branch-sensitive providers. Never use a link or copied branch ID as evidence of access.

The phone is a management installation, not a desktop register. Opening ALYQ Mobile does not create a shift and cannot perform an offline cash sale.

## Management workflows

- **Home:** report-aggregate financial KPIs, order queue, exact branch stock alerts and approval count.
- **Orders:** bounded server queue and existing legal transitions. Cancellation/payment rejection requires a reason.
- **Inventory:** search product, SKU, barcode, color, flexible size or category; each exact variant displays its active-branch shelf.
- **Invoices:** server-side paged transaction search and stored invoice/payment/return/refund evidence.
- **Approvals:** operation-bound existing requests. Approval/rejection retains expiry, branch, fingerprint/correlation, single-use and audit enforcement.
- **Notifications:** stable operational identities deduplicate realtime, refresh and push intent.
- **Health:** existing backend/auth/realtime/schema/branch health plus mobile version, network and notification registration.

All sensitive writes require the authoritative backend online. If disconnected, reconnect and refresh; do not repeat an action whose result is uncertain until its detail is re-read.

## Notification permission

The app asks only after the user chooses **Enable notifications**. Denial does not block the app and the prompt is not shown repeatedly by ALYQ. A safe lock-screen message names a reference such as “New order WEB-123”; it must not include customer phone/address or payment detail.

Logout deactivates the current mobile installation when reachable and unregisters local push. Administrators should also revoke the account/session and invalidate provider tokens for a lost device.

## Troubleshooting

- **Branch data missing:** confirm membership is active, switch branch again while online, then refresh.
- **Deep link denied:** sign in, select the authorized branch, and verify the role still holds the required permission. The app deliberately does not reveal whether a forbidden entity exists.
- **Action unavailable offline:** expected. Management mutations are not queued.
- **No push:** check OS permission and Mobile Health. “Registered” proves token registration, not provider delivery. Production FCM/APNs and entitlement setup must also be healthy.
- **Stale list:** pull/use Refresh. Refresh only reads authoritative state and does not replay actions.
- **Lost phone:** revoke sessions/account access and deactivate provider routing from trusted administration.

## Acceptance record

Record device model, OS version, app version/build, active branch, language/direction, push provider environment and test account role. Physical device, APNs/FCM delivery, store signing and store submission are separate acceptance activities and must not be inferred from software tests.
