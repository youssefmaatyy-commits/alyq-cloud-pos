import { useCallback } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Field, TextInput } from "@/components/ui";
import type { DateRange } from "../services/financialExport";

/**
 * Date-range selection for the reports screen.
 *
 * Values are `yyyy-mm-dd` strings — what `<input type="date">` speaks — and an
 * empty string means "unbounded on that side". `toExportRange` turns them into
 * the `DateRange` the export builders filter with (`null` = unbounded), so the
 * picker never has to know about the builders and vice versa.
 */
export interface DateRangeValue {
  from: string;
  to: string;
}

export const EMPTY_DATE_RANGE: DateRangeValue = { from: "", to: "" };

/** Picker value → the inclusive range the builders accept. */
export function toExportRange(value: DateRangeValue): DateRange {
  return { from: value.from || null, to: value.to || null };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local-time `yyyy-mm-dd`, so "today" means the shop's today, not UTC's. */
export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type RangePreset = "allTime" | "today" | "thisMonth" | "last30";

/** The calendar span a preset covers, in local time. */
export function presetRange(preset: RangePreset, now: Date = new Date()): DateRangeValue {
  switch (preset) {
    case "today":
      return { from: isoDate(now), to: isoDate(now) };
    case "thisMonth":
      return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
    case "last30": {
      const from = new Date(now);
      from.setDate(from.getDate() - 29); // 30 days inclusive of today
      return { from: isoDate(from), to: isoDate(now) };
    }
    case "allTime":
    default:
      return EMPTY_DATE_RANGE;
  }
}

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
    { id: "thisMonth", label: t("export.range.thisMonth") },
    { id: "last30", label: t("export.range.last30") },
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
