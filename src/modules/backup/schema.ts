/**
 * The backup contract — what a document is, what it must contain, and how to tell
 * a real one from a truncated or hand-edited file.
 *
 * Everything here is pure and synchronous, which is not an aesthetic choice: the
 * validator has to run in a browser before a restore, in a Node test with a
 * fixture, and (as SQL, in migration 0029) inside the transaction that is about
 * to delete every row in the database. Three places, one set of rules, and this
 * file is the one the tests read.
 *
 * Two lists drive it:
 *
 *   LIVE_TABLES  the 35 tables in foreign-key dependency order. A restore inserts
 *                in this order and deletes in the reverse, so a parent always
 *                exists before a child points at it. The order is not a
 *                preference — the selftest re-derives it from the migrations and
 *                fails if this list drifts from the schema that produced it.
 *
 *   DEMO_STORES  an allowlist of the offline stores a backup carries. It is an
 *                allowlist rather than "everything in localStorage" because half
 *                of what lives there is not business data: the current session,
 *                the language, which tab a notification was last seen on. Backing
 *                those up would restore a stale session over a live one — the kind
 *                of bug that reads as "the app logged everybody out and then
 *                remembered the wrong person".
 */
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  type BackupDocument,
  type BackupKind,
  type BackupMode,
  type BackupPayload,
} from "./types";

// ── live tables, parents before children ─────────────────────────────────────

export const LIVE_TABLES: readonly string[] = [
  // counters and vocabulary first: nothing points at them, everything may.
  "approval_counters",
  "refund_counters",
  "return_counters",
  "sale_counters",
  "role_aliases",
  "role_capabilities",
  "audit_actions",
  "approval_rules",
  "campaigns",
  "coupons",
  "store_faqs",
  "website_settings",
  // referenced by others
  "categories",
  "custom_roles",
  "customers",
  "store_customers",
  "shifts",
  // children of the above
  "products",
  // Phase 43: a variant row is a child of its product; catalogue codes point
  // at products AND variants. Both must restore between their parents and the
  // code-carrying children, or a restored shop loses every combination.
  "product_variants",
  "catalogue_codes",
  "profiles",
  "expenses",
  "sales",
  "audit_log",
  "online_orders",
  "sales_returns",
  // grandchildren
  "sale_items",
  "sale_payments",
  "stock_movements",
  "product_content",
  // Phase 45: one content row per storefront category — a child of categories,
  // restored beside the rest of the presentation layer.
  "storefront_category_content",
  "store_reviews",
  "online_order_items",
  "order_events",
  "stock_reservations",
  "return_items",
  "refund_records",
  "approval_requests",
];

/** Deletes run in reverse, so no child outlives the row it points at. */
export const LIVE_TABLES_DELETE_ORDER: readonly string[] = [...LIVE_TABLES].reverse();

/**
 * Live tables that are snapshotted but **not** replaced by a restore.
 *
 * Three are vocabulary tables the migrations own: `role_capabilities`,
 * `audit_actions` and `role_aliases`. A snapshot of them is a snapshot of the
 * release that took it, and installing an older copy would quietly downgrade the
 * permission vocabulary underneath a running system — which capabilities exist is
 * read from `role_capabilities`, so a missing row is a permission gone from the
 * picker and from every role that held it. The current release keeps authority
 * over its own words; a backup carries them for the record.
 *
 * `audit_log` is the fourth, for the opposite reason. It is append-only by
 * trigger, and the trail is the one thing a restore must not erase: the entries
 * saying that a restore happened, who asked for it and which snapshot they used
 * are exactly what someone reading the log afterwards needs. A restore therefore
 * leaves the log standing and adds to it. It is still in the document, so an
 * offline copy carries its own history with it.
 */
export const LIVE_RESTORE_EXCLUDED: readonly string[] = [
  // trigger-owned (0043): the sync triggers rebuild it as products/variants
  // come back — re-inserting the captured rows would collide with them.
  "catalogue_codes",
  "role_aliases",
  "role_capabilities",
  "audit_actions",
  "audit_log",
];

/** What a live restore actually rewrites: the order above, minus the exclusions. */
export const LIVE_RESTORE_TABLES: readonly string[] = LIVE_TABLES.filter(
  (table) => !LIVE_RESTORE_EXCLUDED.includes(table),
);

/**
 * The offline stores a restore leaves alone — the mirror of the exclusions above.
 *
 * The audit log is carried by a snapshot (it is evidence, and an installation
 * moving between machines should take it) but is never *rewritten* by a restore:
 * it is append-only, and replacing it with the snapshot's copy would delete the
 * record of the restore itself and of everything that happened between the
 * snapshot and now. The restore dialog promises this in so many words, and
 * migration 0029 enforces the same rule on the live side.
 */
export const DEMO_RESTORE_EXCLUDED: readonly string[] = ["alyq.demo.audit_log.v1"];

/**
 * The offline stores a demo backup carries: business data, the identity
 * directory, and the configuration an installation would otherwise lose.
 */
export const DEMO_STORES: readonly string[] = [
  // identity — including the salt and digests, without which a restored
  // directory would be a list of people nobody could sign in as.
  "alyq.identity.staff.v1",
  "alyq.identity.custom_roles.v1",
  // catalogue
  "alyq.demo.catalog.v1",
  "alyq.demo.product_contents.v1",
  // Phase 45: one content row per storefront category (live side: 0048)
  "alyq.demo.storefront_category_contents.v1",
  // trading
  "alyq.demo.sales.v1",
  "alyq.demo.sale_counter.v1",
  "alyq.demo.customers.v1",
  "alyq.demo.returns.v1",
  "alyq.demo.return_counter.v1",
  "alyq.demo.refunds.v1",
  "alyq.demo.refund_counter.v1",
  "alyq.demo.expenses.v1",
  "alyq.demo.expense_counter.v1",
  "alyq.demo.shifts.v1",
  "alyq.demo.shift_counter.v1",
  "alyq.demo.stock_movements.v1",
  "alyq.demo.stock_reservations.v1",
  // approvals and the audit trail
  "alyq.demo.approval_requests.v1",
  "alyq.demo.approval_rules.v1",
  "alyq.demo.approval_counter.v1",
  "alyq.demo.audit_log.v1",
  // storefront
  "alyq.demo.online_orders.v1",
  "alyq.demo.online_order_counter.v1",
  "alyq.demo.store_customers.v1",
  "alyq.demo.store_faqs.v1",
  "alyq.demo.store_reviews.v1",
  "alyq.demo.campaigns.v1",
  "alyq.demo.coupons.v1",
  "alyq.demo.website_settings.v1",
  "alyq.demo.online_seeded.v1",
];

/**
 * Deliberately NOT backed up, and the reason matters: restoring any of these
 * would put a stale session or a stale UI preference on top of a live one.
 */
export const EXCLUDED_STORES: readonly string[] = [
  "alyq.auth.session.v1",
  "alyq.auth.signal.v1",
  "alyq.demo.store_session.v1",
  "alyq.online.notify.v1",
  "alyq.inventory.currentUser.v1",
  "alyq.lang",
];

// ── checksum ─────────────────────────────────────────────────────────────────

/**
 * FNV-1a, 32 bit, as eight hex characters.
 *
 * Chosen because it is six lines, synchronous, identical in every JavaScript
 * runtime, and needs no `crypto` (which is unavailable on plain http origins —
 * the exact situation an offline demo install is often in). It detects a
 * truncated download, a re-saved file and a hand-edited number. It does not
 * authenticate anything: authority to restore comes from `restore_backup`, and a
 * forged document with a recomputed hash is refused by the capability check, the
 * mode check and the completeness check, not by this.
 */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // 32-bit multiply, split to stay inside the safe-integer range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The string a checksum is taken over: the payload, and nothing else. */
export function checksumInput(payload: BackupPayload): string {
  return JSON.stringify(payload);
}

// ── building ─────────────────────────────────────────────────────────────────

/**
 * Rows in a store value.
 *
 * An array is its length. A record whose every value is an array — the offline
 * catalog, which holds `categories` and `products` under one key — is the sum of
 * those arrays, because counting it as a single row would understate a snapshot
 * by most of its contents. Any other object (a settings singleton) counts as one.
 */
function countRows(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const nested = Object.values(value as Record<string, unknown>);
    if (nested.length > 0 && nested.every((entry) => Array.isArray(entry))) {
      return nested.reduce((total, entry) => total + (entry as unknown[]).length, 0);
    }
    return 1;
  }
  return 0;
}

export interface BuildDocumentInput {
  mode: BackupMode;
  kind: BackupKind;
  note?: string | null;
  payload: BackupPayload;
  actor: { id: string; name: string };
  /** Injectable so a test can pin a timestamp. */
  now?: Date;
  source_revision?: string | null;
  /** Live documents arrive with the database's own md5; demo ones are hashed here. */
  checksum?: string;
}

/** Assemble an envelope around a payload. Same code path in both modes. */
export function buildDocument(input: BuildDocumentInput): BackupDocument {
  const entries =
    input.mode === "supabase"
      ? Object.entries(input.payload.tables ?? {})
      : Object.entries(input.payload.stores ?? {});

  const counts: Record<string, number> = {};
  let rowCount = 0;
  for (const [name, value] of entries) {
    const rows = countRows(value);
    counts[name] = rows;
    rowCount += rows;
  }

  const checksum = input.checksum ?? fnv1aHex(checksumInput(input.payload));
  const sizeBytes =
    typeof Blob !== "undefined"
      ? new Blob([JSON.stringify(input.payload)]).size
      : checksumInput(input.payload).length;

  return {
    format: BACKUP_FORMAT,
    schema_version: BACKUP_SCHEMA_VERSION,
    mode: input.mode,
    kind: input.kind,
    note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
    created_at: (input.now ?? new Date()).toISOString(),
    created_by: { id: input.actor.id, name: input.actor.name },
    source_revision: input.source_revision ?? null,
    counts,
    row_count: rowCount,
    size_bytes: sizeBytes,
    checksum,
    payload: input.payload,
  };
}

/** The file a download writes, and the string a checksum is verified against. */
export function serializeDocument(document: BackupDocument): string {
  return JSON.stringify(document, null, 2);
}

export function backupFileName(document: BackupDocument): string {
  const stamp = document.created_at.replace(/[:.]/g, "-").slice(0, 19);
  // The kind is in the name on purpose: someone choosing a file to restore from a
  // laptop needs to tell a rollback point (`pre_restore`) from a routine snapshot
  // without opening it.
  return `alyq-backup-${document.mode}-${document.kind}-${stamp}.json`;
}

// ── validation ───────────────────────────────────────────────────────────────

export type BackupValidationCode =
  | "unparseable"
  | "bad_format"
  | "bad_version"
  | "mode_mismatch"
  | "checksum_mismatch"
  | "incomplete"
  | "empty";

export type BackupValidation =
  | { ok: true; document: BackupDocument; missing: string[] }
  | { ok: false; code: BackupValidationCode; message: string };

/** What the document must contain for the mode that will consume it. */
export function requiredKeys(mode: BackupMode): readonly string[] {
  return mode === "supabase" ? LIVE_TABLES : DEMO_STORES;
}

/**
 * Read a file's worth of text into a document, or say precisely why it is not one.
 *
 * The order of the checks is the order an operator needs them: is it JSON at all,
 * is it one of ours, is it a version this build understands, was it made by the
 * mode we are about to restore into, is it whole, and only then does the checksum
 * matter. Each refusal names a code the UI translates, so "restore failed" is
 * never the whole sentence.
 */
export function parseBackupDocument(
  text: string,
  options: { mode: BackupMode; ignoreChecksum?: boolean } = { mode: "demo" },
): BackupValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "unparseable", message: "not valid JSON" };
  }
  return validateBackupDocument(raw, options);
}

export function validateBackupDocument(
  input: unknown,
  options: { mode: BackupMode; ignoreChecksum?: boolean },
): BackupValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "unparseable", message: "not an object" };
  }
  const candidate = input as Partial<BackupDocument>;

  if (candidate.format !== BACKUP_FORMAT) {
    return { ok: false, code: "bad_format", message: `format is ${String(candidate.format)}` };
  }
  if (candidate.schema_version !== BACKUP_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "bad_version",
      message: `schema_version ${String(candidate.schema_version)} ≠ ${BACKUP_SCHEMA_VERSION}`,
    };
  }
  if (candidate.mode !== "demo" && candidate.mode !== "supabase") {
    return { ok: false, code: "mode_mismatch", message: `unknown mode ${String(candidate.mode)}` };
  }
  if (candidate.mode !== options.mode) {
    return {
      ok: false,
      code: "mode_mismatch",
      message: `a ${candidate.mode} backup cannot be restored into a ${options.mode} installation`,
    };
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return { ok: false, code: "empty", message: "no payload" };
  }

  const held =
    candidate.mode === "supabase"
      ? Object.keys((candidate.payload as BackupPayload).tables ?? {})
      : Object.keys((candidate.payload as BackupPayload).stores ?? {});
  const missing = requiredKeys(candidate.mode).filter((key) => !held.includes(key));
  // A document missing tables is the dangerous case: restoring it would leave the
  // installation with some of its data replaced and some untouched, which is worse
  // than either. Refused outright, and named.
  if (missing.length > 0) {
    return { ok: false, code: "incomplete", message: `missing ${missing.join(", ")}` };
  }
  if (held.length === 0) {
    return { ok: false, code: "empty", message: "payload holds nothing" };
  }
  // Every store present and every one of them empty is not a fresh installation
  // worth restoring: it is a file that lost its contents, and pouring it in would
  // empty the shop while reporting success.
  const totalRows = Object.values((candidate.counts ?? {}) as Record<string, number>).reduce(
    (sum, rows) => sum + (Number.isFinite(rows) ? rows : 0),
    0,
  );
  if (totalRows === 0) {
    return { ok: false, code: "empty", message: "the backup holds no rows" };
  }

  if (!options.ignoreChecksum && candidate.mode === "demo") {
    // Live documents carry the database's md5, which only the database can
    // recompute; migration 0029 verifies it inside the restore transaction,
    // before anything is deleted.
    const expected = fnv1aHex(checksumInput(candidate.payload as BackupPayload));
    if (candidate.checksum !== expected) {
      return {
        ok: false,
        code: "checksum_mismatch",
        message: `checksum ${String(candidate.checksum)} ≠ ${expected}`,
      };
    }
  }

  return { ok: true, document: candidate as BackupDocument, missing: [] };
}

/** A one-line description for a list row or a toast. */
export function describeDocument(document: BackupDocument): string {
  const keys =
    document.mode === "supabase"
      ? Object.keys(document.payload.tables ?? {}).length
      : Object.keys(document.payload.stores ?? {}).length;
  return `${keys} ${document.mode === "supabase" ? "tables" : "stores"} · ${document.row_count} rows`;
}
