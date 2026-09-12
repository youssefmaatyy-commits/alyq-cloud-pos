import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, Button, Card, SectionTitle, StatTile } from "@/components/ui";
import { ArchiveIcon, EditIcon, RestoreIcon } from "@/components/ui";
import { PRODUCT_TYPE_META } from "../constants";
import { marginPct, stockStatus, type Product } from "../types";
import { canAct } from "@/lib/permissions/enforce";
import { ActiveBadge, ProductTypeBadge } from "./ProductTypeBadge";
import { StockBadge } from "./ProductTable";

function Row({ label, value, dir }: { label: string; value: React.ReactNode; dir?: "ltr" | "rtl" }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-50 py-2 last:border-0">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{label}</span>
      <span className="text-sm font-semibold text-slate-900" dir={dir}>
        {value}
      </span>
    </div>
  );
}

export function ProductDetails({
  product,
  categoryName,
  onToggleActive,
  busy,
}: {
  product: Product;
  categoryName: (id: string | null) => string;
  onToggleActive: () => void;
  busy?: boolean;
}) {
  const { t, money, num, date } = useI18n();
  const margin = marginPct(product.selling_price, product.cost_price);
  // Phase 17: cost price, profit and margin are one fact seen three ways, so
  // `view_cost` governs all three. The selling price stays visible to everybody
  // who can open the catalogue — it is the number the till charges.
  const maySeeCost = canAct("view_cost");
  const status = stockStatus(product);
  const descAr = product.description_ar;
  const descEn = product.description_en;
  const gallery = product.images ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 text-2xl font-bold text-slate-600">
            {product.image_url ? (
              <img src={product.image_url} alt="" className="h-full w-full object-cover" />
            ) : (
              (product.name_en || product.name_ar || "?").charAt(0).toUpperCase()
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {product.is_featured ? (
                <span title={t("products.featuredBadge")} aria-label={t("products.featuredBadge")}>
                  ⭐
                </span>
              ) : null}
              <h2 className="text-lg font-semibold text-slate-900" dir="rtl">
                {product.name_ar}
              </h2>
            </div>
            <p className="text-sm font-medium text-slate-700" dir="ltr">
              {product.name_en}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <ProductTypeBadge type={product.product_type} />
              <ActiveBadge active={product.active} />
              {product.stock_tracking_enabled ? <Badge tone="info">{t("products.stockTracking")}</Badge> : null}
              <StockBadge status={status} />
              {product.is_featured ? <Badge tone="warning">{t("products.featuredBadge")}</Badge> : null}
              {!product.show_on_website ? <Badge>{t("products.hiddenOnWebsite")}</Badge> : null}
              {product.barcode ? (
                <Badge className="font-mono">{product.barcode}</Badge>
              ) : (
                <Badge>{t("products.barcode")}: —</Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/products/${product.id}/edit`}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 transition-colors hover:bg-slate-50"
            >
              <EditIcon />
              {t("common.edit")}
            </Link>
            <Button variant={product.active ? "danger" : "primary"} onClick={onToggleActive} loading={busy}>
              {product.active ? <ArchiveIcon /> : <RestoreIcon />}
              {product.active ? t("common.archive") : t("common.restore")}
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("products.sellingPrice")} value={money(product.selling_price)} tone="success" />
        {maySeeCost ? (
          <>
            <StatTile label={t("products.costPrice")} value={money(product.cost_price)} />
            <StatTile
              label={t("products.profit")}
              value={money(product.selling_price - product.cost_price)}
              hint={margin === null ? undefined : `${t("products.margin")} ${num(margin, 1)}%`}
              tone={margin !== null && margin < 0 ? "danger" : "success"}
            />
          </>
        ) : null}
        <StatTile
          label={t("common.stock")}
          value={status === "none" ? "—" : num(product.stock_quantity, 0)}
          hint={status === "low" ? t("products.lowStockBadge") : status === "out" ? t("products.outOfStock") : status === "none" ? t("products.notTracked") : t("products.inStock")}
          tone={status === "out" ? "danger" : status === "low" ? "warning" : status === "in" ? "success" : "neutral"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>{t("common.details")}</SectionTitle>
          <Row label={t("products.sku")} value={<span className="font-mono">{product.sku}</span>} dir="ltr" />
          <Row
            label={t("products.barcode")}
            value={<span className="font-mono">{product.barcode ?? "—"}</span>}
            dir="ltr"
          />
          <Row label={t("products.category")} value={categoryName(product.category_id)} />
          <Row
            label={t("products.type")}
            value={`${PRODUCT_TYPE_META[product.product_type].icon} ${t(
              PRODUCT_TYPE_META[product.product_type].labelKey as never,
            )} — ${t(PRODUCT_TYPE_META[product.product_type].hintKey as never)}`}
          />
          <Row
            label={t("products.taxRate")}
            value={`${num(product.tax_rate, 2)}% · ${money(
              product.selling_price * (1 + product.tax_rate / 100),
            )}`}
          />
          <Row
            label={t("products.stockTracking")}
            value={product.stock_tracking_enabled ? t("common.yes") : t("common.no")}
          />
          {product.stock_tracking_enabled ? (
            <>
              <Row label={t("products.stockQuantity")} value={num(product.stock_quantity, 0)} dir="ltr" />
              <Row label={t("products.lowStockLevel")} value={num(product.low_stock_level, 0)} dir="ltr" />
            </>
          ) : null}
          <Row
            label={t("products.showOnWebsite")}
            value={product.show_on_website ? t("common.yes") : t("common.no")}
          />
          <Row
            label={t("products.featured")}
            value={product.is_featured ? t("common.yes") : t("common.no")}
          />
        </Card>

        <Card>
          <SectionTitle>{t("products.descriptionAr")} / {t("products.descriptionEn")}</SectionTitle>
          <p className="text-sm font-medium leading-relaxed text-slate-800" dir="rtl" lang="ar">
            {descAr ?? "—"}
          </p>
          <p className="mt-3 text-sm font-medium leading-relaxed text-slate-800" dir="ltr">
            {descEn ?? "—"}
          </p>
          <div className="mt-4 border-t border-slate-100 pt-3">
            <Row label={t("common.created")} value={date(product.created_at)} />
            <Row label={t("common.updated")} value={date(product.updated_at)} />
            <Row label="ID" value={<span className="font-mono text-xs">{product.id}</span>} dir="ltr" />
          </div>
        </Card>
      </div>

      {(product.image_url || gallery.length > 0) && (
        <Card>
          <SectionTitle>{t("products.images")}</SectionTitle>
          <div className="flex flex-wrap gap-2.5">
            {[product.image_url, ...gallery]
              .filter((url): url is string => Boolean(url && url.trim()))
              .map((url, index) => (
                <div
                  key={`${index}-${url}`}
                  className="relative h-24 w-24 overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
                  title={index === 0 ? t("products.cover") : undefined}
                >
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={(event) => {
                      (event.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                  {index === 0 ? (
                    <span className="absolute inset-x-0 bottom-0 bg-indigo-600/80 px-1 py-0.5 text-center text-[10px] font-bold uppercase text-white">
                      {t("products.cover")}
                    </span>
                  ) : null}
                </div>
              ))}
          </div>
        </Card>
      )}
    </div>
  );
}
