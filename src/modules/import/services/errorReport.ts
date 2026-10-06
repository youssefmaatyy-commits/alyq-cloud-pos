/**
 * Import Error Report Generator.
 *
 * Generates downloadable CSV and styled Excel workbooks containing detailed
 * error descriptions, affected rows/fields, and suggested fixes.
 */
import type { PreviewIssue } from "../types";

export function buildErrorReportCsv(issues: readonly PreviewIssue[]): string {
  const lines = ["row,field,level,code,message,suggested_fix"];
  for (const issue of issues) {
    lines.push(
      [
        issue.row,
        issue.field,
        issue.level,
        issue.code,
        issue.message,
        issue.suggestedFix ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

function csvCell(value: string | number): string {
  const text = String(value).replace(/"/g, '""');
  return /[",\n]/.test(text) ? `"${text}"` : text;
}

export async function generateErrorReportExcel(
  issues: readonly PreviewIssue[],
  originalHeaders: string[] = [],
  originalRows: string[][] = [],
): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  // 1. Issues Summary Sheet
  const issueHeaders = [
    "Row Number / رقم الصف",
    "Field / الحقل",
    "Severity / مستوى الخطأ",
    "Error Code / كود الخطأ",
    "Error Description / تفاصيل الخطأ",
    "Suggested Fix / الإجراء المقترح للتصحيح",
  ];

  const issueRows = issues.map((issue) => [
    issue.row,
    issue.field,
    issue.level.toUpperCase(),
    issue.code,
    issue.message,
    issue.suggestedFix || "Review cell value and correct per validation rules",
  ]);

  const issueWs = XLSX.utils.aoa_to_sheet([issueHeaders, ...issueRows]);
  issueWs["!cols"] = [
    { wch: 14 },
    { wch: 18 },
    { wch: 14 },
    { wch: 22 },
    { wch: 45 },
    { wch: 50 },
  ];
  XLSX.utils.book_append_sheet(wb, issueWs, "Validation Issues");

  // 2. Original Data with Row Numbers (if provided)
  if (originalHeaders.length > 0 && originalRows.length > 0) {
    const dataHeaders = ["Row #", ...originalHeaders];
    const dataRows = originalRows.map((row, idx) => [idx + 2, ...row]);
    const dataWs = XLSX.utils.aoa_to_sheet([dataHeaders, ...dataRows]);
    XLSX.utils.book_append_sheet(wb, dataWs, "Uploaded Data");
  }

  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return buffer;
}
