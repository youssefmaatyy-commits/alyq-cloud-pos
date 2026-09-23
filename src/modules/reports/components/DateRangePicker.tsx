import { useCallback } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Field, TextInput } from "@/components/ui";
import { presetRange, type DateRangeValue, type RangePreset } from "../services/dateRanges";

/**
 * Date-range selection for the reports screen.
 *
 * The window maths — what "this month" or "the last 30 days" means, and how a
 * picker value becomes the range the export builders filter with — lives in
 * `../services/dateRanges`, so a headless caller (the dashboard query layer) can
 * read the same windows without importing a component. Everything below is the
 * rendering of that: two date inputs and the preset buttons.
 */
export {
  EMPTY_DATE_RANGE,
  isoDate,
  lastDaysRange,
  monthToDateRange,
  presetRange,
  toExportRange,
} from "../services/dateRanges";
export type { DateRangeValue, RangePreset } from "../services/dateRanges";

export interface DateRangePickerProps {
  value: DateRangeValue;
  onChange(next: DateRangeValue): void;
  /** Which preset is currently highlighted, when any. */
  activePreset?: RangePreset | null;
  onPreset?(preset: RangePreset): void;
}

export function DateRangePicker({
  value,
  onChange,
  activePreset = null,
  onPreset,
}: DateRangePickerProps) {
  const { t } = useI18n();

  const applyPreset = useCallback(
    (preset: RangePreset) => {
      onChange(presetRange(preset));
      onPreset?.(preset);
    },
    [onChange, onPreset],
  );

  const presets: { id: RangePreset; label: string }[] = [
    { id: "allTime", label: t("export.range.allTime") },
    { id: "today", label: t("export.range.today") },
    { id: "yesterday", label: t("export.range.yesterday") },
    { id: "last7", label: t("export.range.last7") },
    { id: "last30", label: t("export.range.last30") },
    { id: "thisMonth", label: t("export.range.thisMonth") },
    { id: "previousMonth", label: t("export.range.previousMonth") },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("export.from")}>
          <TextInput
            type="date"
            value={value.from}
            max={value.to || undefined}
            aria-label={t("export.from")}
            onChange={(event) => {
              onChange({ ...value, from: event.target.value });
              onPreset?.("allTime");
            }}
          />
        </Field>
        <Field label={t("export.to")}>
          <TextInput
            type="date"
            value={value.to}
            min={value.from || undefined}
            aria-label={t("export.to")}
            onChange={(event) => {
              onChange({ ...value, to: event.target.value });
              onPreset?.("allTime");
            }}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
          {t("export.presets")}
        </span>
        {presets.map((preset) => (
          <Button
            key={preset.id}
            size="sm"
            variant={activePreset === preset.id ? "primary" : "secondary"}
            onClick={() => applyPreset(preset.id)}
          >
            {preset.label}
          </Button>
        ))}
        {value.from || value.to ? (
          <Button size="sm" variant="ghost" onClick={() => applyPreset("allTime")}>
            {t("export.clear")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
