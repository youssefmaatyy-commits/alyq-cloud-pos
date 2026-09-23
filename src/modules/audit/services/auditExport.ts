/**
 * Audit trail export — the trail as evidence, not as a screen.
 *
 * The audit page is a reading surface: it paginates by recency and answers "what
 * happened here?". An extract is a different document. Somebody is putting it in
 * a folder, forwarding it to an owner, or diffing two months of it, so it carries
 * the whole filtered set — every column the trail stores, in the order the
 * events happened, with the action and entity written as words rather than as
 * the dotted keys the code uses.
 *
 * Two rules this file follows from the rest of the export system:
 *
 *   · It is **read-only**. Building a sheet writes nothing and records nothing —
 *     exporting the trail is not itself an audited act here, because the
 *     capability check (`audit.view` + `audit.export`, asserted by the button
 *     before this runs) is what governs it, and `ExportButton` is the one place
 *     that assertion happens.
 *   · It exports **what the screen is showing**. The caller passes the filtered
 *     entries, so "export the audit for March, for this cashier, for stock
 *     actions" produces exactly the rows on screen and no others.
 *
 * Details are flattened to `key: value` pairs joined with ` · `, the same
 * rendering the page uses, so a row in the file reads like the row it came from.
 * Nothing is truncated: an audit extract that drops fields is worse than none.
 */
import { buildSheets, toDate, type BuiltSheet, type ExportSheet, type Translate } from "@/lib/export";
import type { AuditLogEntry } from "../types";

export interface AuditExportInput {
  /** Already filtered — the rows the screen is showing. */
  entries: readonly AuditLogEntry[];
  t: Translate;
}

/** One row of the extract: the entry, with its keys resolved to words. */
export interface AuditExportRow {
  at: string;
  action: string;
  entity: string;
  record: string;
  user: string;
  details: string;
}

/** The trail as flat rows, oldest first — a timeline reads downwards. */
export function auditRowsOf(entries: readonly AuditLogEntry[], t: Translate): AuditExportRow[] {
  return [...entries]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((entry) => ({
      at: entry.created_at,
      // Resolved through the dictionary: the file is read by people who never
      // see the code, and `stock.corrected` is not a phrase anybody uses.
      action: t(`audit.action.${entry.action}` as never),
      entity: t(`audit.entity.${entry.entity}` as never),
      record: entry.entity_label,
      user: entry.user_name,
      details: Object.entries(entry.details ?? {})
        .map(([key, value]) => `${key}: ${value ?? ""}`)
        .join(" · "),
    }));
}

/** The one sheet: every entry in range, every column the trail stores. */
export function auditSheetOf(input: AuditExportInput): ExportSheet<AuditExportRow> {
  const { t } = input;
  return {
    name: t("export.sheet.audit"),
    rows: auditRowsOf(input.entries, t),
    columns: [
      {
        header: t("audit.when"),
        value: (r) => toDate(r.at),
        kind: "datetime",
        width: 20,
      },
      { header: t("audit.action"), value: (r) => r.action, width: 26 },
      { header: t("audit.entity"), value: (r) => r.entity, width: 16 },
      { header: t("audit.record"), value: (r) => r.record, width: 22 },
      { header: t("pos.cols.user"), value: (r) => r.user, width: 22 },
      { header: t("audit.details"), value: (r) => r.details, width: 70 },
    ],
    notes: [t("export.note.audit")],
  };
}

/** Build the workbook. Sheets are built at click time by `ExportButton`. */
export function buildAuditSheets(input: AuditExportInput): BuiltSheet[] {
  return buildSheets([auditSheetOf(input) as ExportSheet<unknown>]);
}
