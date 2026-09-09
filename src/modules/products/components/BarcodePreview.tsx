import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { encodeCode128 } from "../services/barcode";

/**
 * Live Code 128 barcode preview.
 *
 * Rendered as inline SVG so it stays crisp at any zoom and prints cleanly.
 * The symbol itself is always LTR (barcodes have a fixed scan direction) even
 * when the surrounding UI is in Arabic RTL — hence the explicit `dir="ltr"`.
 */
export function BarcodePreview({
  value,
  height = 56,
  moduleWidth = 1.7,
  showText = true,
  className,
}: {
  value: string;
  height?: number;
  moduleWidth?: number;
  showText?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const encoded = useMemo(() => encodeCode128(value), [value]);

  if (!value.trim()) {
    return (
      <div
        className={`flex h-24 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 text-center text-xs font-medium text-slate-500 ${className ?? ""}`}
      >
        {t("barcode.emptyPreview")}
      </div>
    );
  }

  if (!encoded) {
    return (
      <div
        className={`flex h-24 items-center justify-center rounded-xl border border-rose-200 bg-rose-50 px-3 text-center text-xs font-semibold text-rose-700 ${className ?? ""}`}
      >
        ⚠ {t("barcode.unsupported")}
      </div>
    );
  }

  const textHeight = showText ? 18 : 0;
  const totalWidth = encoded.width * moduleWidth;
  const totalHeight = height + textHeight;

  return (
    <div
      dir="ltr"
      className={`flex items-center justify-center overflow-x-auto rounded-xl border border-slate-200 bg-white p-2 ${className ?? ""}`}
    >
      <svg
        role="img"
        aria-label={`${t("products.barcode")}: ${encoded.value}`}
        width={totalWidth}
        height={totalHeight}
        viewBox={`0 0 ${totalWidth} ${totalHeight}`}
        className="max-w-full"
        data-testid="barcode-svg"
        data-barcode-value={encoded.value}
      >
        <rect width={totalWidth} height={totalHeight} fill="#fff" />
        {encoded.bars.map((bar, index) => (
          <rect
            key={index}
            x={bar.x * moduleWidth}
            y={0}
            width={bar.width * moduleWidth}
            height={height}
            fill="#0f172a"
          />
        ))}
        {showText ? (
          <text
            x={totalWidth / 2}
            y={height + 14}
            textAnchor="middle"
            fontFamily="ui-monospace, Menlo, monospace"
            fontSize={13}
            letterSpacing={1}
            fill="#0f172a"
          >
            {encoded.value}
          </text>
        ) : null}
      </svg>
    </div>
  );
}
