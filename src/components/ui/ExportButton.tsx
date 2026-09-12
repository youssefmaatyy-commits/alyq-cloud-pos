import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { downloadWorkbook, exportCurrency, type BuiltSheet } from "@/lib/export";
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
}

export function ExportButton({
  name,
  build,
  count,
  label,
  variant = "secondary",
  size = "md",
  className,
}: ExportButtonProps) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // An empty export is a mistake, not a feature: say so instead of writing a
  // header-only file the user has to open to discover.
  const nothingToExport = count !== undefined && count <= 0;

  const run = useCallback(async () => {
    if (busy || nothingToExport) return;
    setBusy(true);
    try {
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
      // Never let a failed download look like a silent no-op.
      console.error("Excel export failed:", error);
      toast.error(t("export.failed"));
    } finally {
      setBusy(false);
    }
  }, [busy, nothingToExport, build, name, lang, t, toast]);

  return (
    <Button
      variant={variant}
      size={size}
      loading={busy}
      disabled={nothingToExport}
      title={nothingToExport ? t("export.empty") : undefined}
      className={className}
      onClick={() => void run()}
    >
      {!busy ? <DownloadIcon /> : null}
      {label ?? t("export.button")}
    </Button>
  );
}
