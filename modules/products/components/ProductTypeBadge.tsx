import { PRODUCT_TYPE_META } from "../constants";
import type { ProductType } from "../types";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { cn } from "@/utils/cn";

export function ProductTypeBadge({
  type,
  withIcon = true,
  className,
}: {
  type: ProductType;
  withIcon?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const meta = PRODUCT_TYPE_META[type];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        meta.tone,
        className,
      )}
      title={t(meta.hintKey as never)}
    >
      {withIcon ? <span aria-hidden>{meta.icon}</span> : null}
      {t(meta.labelKey as never)}
    </span>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useI18n();
  return active ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      {t("products.activeBadge")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      {t("products.inactiveBadge")}
    </span>
  );
}
