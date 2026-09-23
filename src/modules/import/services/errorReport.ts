/** A downloadable error report. Cells are escaped. No file bytes are embedded. */
import type { PreviewIssue } from "../types";

export function buildErrorReportCsv(issues: readonly PreviewIssue[]): string {
  const lines = ["row,field,level,code,message"];
  for (const issue of issues) {
    lines.push([issue.row, issue.field, issue.level, issue.code, issue.message].map(csvCell).join(","));
  }
  return lines.join("\n");
}

function csvCell(value: string | number): string {
  const text = String(value).replace(/"/g, "\"\"");
  return /[",\n]/.test(text) ? `"${text}"` : text;
}
