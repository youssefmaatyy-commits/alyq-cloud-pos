/**
 * Report authority — who may read a report, and who may take one out.
 *
 * Two capabilities, because they are two different questions:
 *
 *   · `view_reports` — may this person see the numbers? Every role that can open
 *     the reports screen holds it, so this refuses nobody who could already read
 *     the page; it refuses the caller who reached the service some other way.
 *   · `export_reports` — may they produce a file of a *report* (a summarised,
 *     formatted document somebody will forward)?
 *   · `export_data` — may they produce a raw extract (every invoice row, the
 *     whole customer book, the stock list)? This is the broader power and the one
 *     the data-export buttons ask for.
 *
 * The distinction is not decoration: an installation that wants a supervisor to
 * read the daily numbers but not walk out with the customer list grants
 * `view_reports` and `export_reports` and withholds `export_data`.
 *
 * Everything here is a thin, named gate over the sensitive-action register, so
 * the mapping lives in one place and the enforcement suite can read it. In live
 * mode the rows themselves are already limited by RLS — a caller only ever
 * exports what they could select — which is why this file governs the *act* of
 * exporting rather than trying to filter the data again.
 */
import { assertSensitiveAction, sensitiveAction } from "@/lib/permissions/actions";
import { canAct } from "@/lib/permissions/enforce";
import type { Capability } from "@/lib/permissions/roles";

/** Which kind of file a button produces: a report, or a raw data extract. */
export type ExportAuthority = "report" | "data";

/** May the acting user read reports at all? */
export function assertCanViewReports(): void {
  assertSensitiveAction("report.view");
}

/** May the acting user export a formatted report? */
export function assertCanExportReports(): void {
  assertSensitiveAction("report.export");
}

/** May the acting user export a raw data extract? */
export function assertCanExportData(): void {
  assertSensitiveAction("data.export");
}

/** The capability a given kind of export needs, read from the register. */
export function exportAuthorityFor(kind: ExportAuthority): Capability {
  return sensitiveAction(kind === "report" ? "report.export" : "data.export").capability;
}

/** Refuse an export of this kind unless the acting user may produce it. */
export function assertCanExport(kind: ExportAuthority): void {
  if (kind === "report") assertCanExportReports();
  else assertCanExportData();
}

/** The same question as a boolean, for a button that should be disabled. */
export function mayExport(kind: ExportAuthority): boolean {
  return canAct(exportAuthorityFor(kind));
}

/** May the acting user see the reports screen's numbers? */
export function mayViewReports(): boolean {
  return canAct(sensitiveAction("report.view").capability);
}
