import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { downloadWorkbook, exportCurrency, type BuiltSheet } from "@/lib/export";
import { deniedMessageKey } from "@/lib/permissions/enforce";
import {
  assertCanExport,
  exportAuthorityFor,
  mayExport,
  type ExportAuthority,
} from "@/modules/reports/services/reportAccess";
import type { TranslationKey } from "@/lib/i18n/I18nProvider";
import { AppError } from "@/modules/products/data/repository";
import { Button } from "./Button";
import { DownloadIcon } from "./icons";
import { useToast } from "./Toast";

/**
 * The one Excel export button in the app.
 *
 * Every screen exports through this, so the behaviour cannot drift: the sheets
 * are built **at click time** (never on render), which is what makes "export
 * filtered data if filters are applied" true by construction — the builder
 * closes over whatever the screen is showing right now.
 *
 * Read-only by design: it renders a file from data the providers already hold.
 * No repository call, no write, no audit entry.
 *
 * Not authority-free, though. An export is the moment data leaves the building,
 * so the button states which kind of file it produces (`authority`) and the
 * capability behind that kind is asserted at click time — not merely used to hide
 * the button. A caller who reaches `run()` without it gets the denial in their
 * own language instead of a spreadsheet.
 */
export interface ExportButtonProps {
  /** Base file name without extension; a timestamp is appended. */
  name: string;
  /** Builds the sheets on click. May be async (the builders are pure, though). */
  build(): BuiltSheet[] | Promise<BuiltSheet[]>;
  /** Rows the export would contain. `0` disables the button with an explanation. */
  count?: number;
  /** Override the default label ("Export Excel"). */
  label?: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md" | "lg";
  className?: string;
  /**
   * What the file is: a summarised `report`, or a raw `data` extract. Decides
   * which capability is asserted (`export_reports` / `export_data`).
   */
  authority?: ExportAuthority;
}

export function ExportButton({
  name,
  build,
  count,
  label,
  variant = "secondary",
  size = "md",
  className,
  authority = "data",
}: ExportButtonProps) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // An empty export is a mistake, not a feature: say so instead of writing a
  // header-only file the user has to open to discover.
  const nothingToExport = count !== undefined && count <= 0;
  const allowed = mayExport(authority);
  const deniedKey = deniedMessageKey(exportAuthorityFor(authority)) as TranslationKey;

  const run = useCallback(async () => {
    if (busy || nothingToExport) return;
    setBusy(true);
    try {
      // Asserted before the sheets are built: a refused export should cost
      // nothing, and the denial is the same AppError every screen knows.
      assertCanExport(authority);
      const sheets = await build();
      // Check *before* writing: a builder can legitimately return header-only
      // sheets (e.g. no purchase movements in range), and downloading an empty
      // workbook while toasting "nothing to export" would contradict itself.
      const rows = sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0);
      if (rows === 0) {
        toast.push(t("export.empty"), "info");
        return;
      }
      const result = await downloadWorkbook({
        name,
        sheets,
        currency: exportCurrency(),
        lang,
      });
      toast.success(t("export.success", { count: result.totalRows, file: result.filename }));
    } catch (error) {
      // A denial is an answer, not a failure: name the permission that is missing
      // rather than reporting that Excel "failed".
      if (error instanceof AppError && error.code === "FORBIDDEN") {
        toast.error(t(deniedKey));
        return;
      }
      // Never let a failed download look like a silent no-op.
      console.error("Excel export failed:", error);
      toast.error(t("export.failed"));
    } finally {
      setBusy(false);
    }
  }, [busy, nothingToExport, build, name, lang, t, toast, authority, deniedKey]);

  // Authorization removes the action entirely. State-based unavailability (an
  // empty result set or an export already running) may still render disabled.
  if (!allowed) return null;

  return (
    <Button
      variant={variant}
      size={size}
      loading={busy}
      disabled={nothingToExport || !allowed}
      title={!allowed ? t(deniedKey) : nothingToExport ? t("export.empty") : undefined}
      className={className}
      onClick={() => void run()}
    >
      {!busy ? <DownloadIcon /> : null}
      {label ?? t("export.button")}
    </Button>
  );
}
