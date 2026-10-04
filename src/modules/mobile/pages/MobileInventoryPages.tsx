import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { can } from "@/lib/permissions/enforce";
import { useBranch } from "@/lib/branch";
import { useInventory } from "@/modules/inventory";
import { useCatalog } from "@/modules/products";
import { listColorImages } from "@/modules/products/services/variantService";
import { variantLabel, variantStatus, type ProductColorImage, type ProductVariant, type VariantStatus } from "@/modules/products/variants";
import type { Product } from "@/modules/products/types";
import { MobileBadge, MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";

interface MobileInventoryRow {
  product: Product;
  variant: ProductVariant | null;
  label: string;
  stock: number;
  status: VariantStatus;
}

export function MobileInventoryPage() {
  const { lang } = useI18n();
  const inventory = useInventory();
  const catalog = useCatalog();
  const branch = useBranch();
  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(params.get("status") === "low" || params.get("status") === "out" ? params.get("status")! : "all");

  const rows = useMemo<MobileInventoryRow[]>(() => {
    const query = search.trim().toLocaleLowerCase();
    const result: MobileInventoryRow[] = [];
    for (const product of inventory.products) {
      const variants = inventory.variantsByProduct.get(product.id) ?? [];
      if (!product.variants_enabled || variants.length === 0) {
        const ownStatus: VariantStatus = product.stock_quantity <= 0 ? "out" : product.low_stock_level > 0 && product.stock_quantity <= product.low_stock_level ? "low" : "in";
        const haystack = `${product.name_ar} ${product.name_en} ${product.sku} ${product.barcode ?? ""}`.toLocaleLowerCase();
        if ((!query || haystack.includes(query)) && (status === "all" || status === ownStatus)) result.push({ product, variant: null, label: "", stock: product.stock_quantity, status: ownStatus });
        continue;
      }
      for (const variant of variants.filter((entry) => entry.active)) {
        const row: MobileInventoryRow = { product, variant, label: variantLabel(variant, lang), stock: variant.stock_quantity, status: variantStatus(variant) };
        const haystack = `${product.name_ar} ${product.name_en} ${variant.sku} ${variant.barcode ?? ""} ${variant.color_ar ?? ""} ${variant.color_en ?? ""} ${variant.size_value ?? variant.size_label ?? variant.size ?? ""} ${product.category_id ?? ""}`.toLocaleLowerCase();
        if ((!query || haystack.includes(query)) && (status === "all" || status === row.status)) result.push(row);
      }
    }
    return result.slice(0, 100);
  }, [inventory.products, inventory.variantsByProduct, search, status, lang]);

  if (!can("inventory.view")) return <MobilePage title="Inventory"><MobileState kind="denied" title="Inventory access denied" /></MobilePage>;
  return <MobilePage title="Inventory" subtitle={`${branch.current?.code ?? "—"} · exact branch shelves`} actions={<button className="mobile-action" type="button" onClick={() => void inventory.refresh()}>Refresh</button>}>
    <div className="mobile-filter-row"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Product, SKU, barcode, color, size" aria-label="Search inventory" /><select aria-label="Stock status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All stock</option><option value="low">Low stock</option><option value="out">Out of stock</option><option value="in">In stock</option></select></div>
    {inventory.loading || catalog.loading ? <MobileState kind="loading" title="Loading branch inventory…" />
      : inventory.error ? <MobileState kind="error" title="Inventory unavailable" detail={inventory.error.message} retry={() => void inventory.refresh()} />
        : rows.length === 0 ? <MobileState kind="empty" title="No matching branch stock" />
          : <div className="mobile-list">{rows.map((row) => <Link className="mobile-list-link" key={row.variant?.id ?? row.product.id} to={`/mobile/inventory/${row.product.id}`}>
            <MobileCard><div className="mobile-row"><strong>{lang === "ar" ? row.product.name_ar : row.product.name_en}</strong><MobileBadge tone={row.status === "out" ? "danger" : row.status === "low" ? "warning" : "success"}>{row.status}</MobileBadge></div>{row.label ? <p>{row.label}</p> : null}<div className="mobile-row mobile-muted"><span dir="ltr">{row.variant?.sku ?? row.product.sku} · {row.variant?.barcode ?? row.product.barcode ?? "—"}</span><strong>{row.stock}</strong></div></MobileCard>
          </Link>)}</div>}
    {rows.length === 100 ? <p className="mobile-bounded-note">Showing the first 100 matches. Narrow the search to locate another exact shelf.</p> : null}
  </MobilePage>;
}

export function MobileProductDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { lang, money } = useI18n();
  const inventory = useInventory();
  const catalog = useCatalog();
  const product = inventory.products.find((entry) => entry.id === id);
  const variants = inventory.variantsByProduct.get(id) ?? [];
  const [galleries, setGalleries] = useState<ProductColorImage[]>([]);
  useEffect(() => { if (product) void listColorImages(product.id).then(setGalleries).catch(() => setGalleries([])); }, [product?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!can("inventory.view")) return <MobilePage title="Product"><MobileState kind="denied" title="Product access denied" /></MobilePage>;
  if (inventory.loading || catalog.loading) return <MobilePage title="Product"><MobileState kind="loading" title="Loading product…" /></MobilePage>;
  if (!product) return <MobilePage title="Product"><MobileState kind="denied" title="Product unavailable" detail="It is not visible in the active branch context." /></MobilePage>;
  const images = [...new Set([product.image_url, ...product.images, ...galleries.map((image) => image.image_url)].filter(Boolean) as string[])];
  return <MobilePage title={lang === "ar" ? product.name_ar : product.name_en} subtitle={product.sku} actions={<button type="button" className="mobile-action" onClick={() => navigate(-1)}>Back</button>}>
    {images.length ? <div className="mobile-gallery">{images.map((image) => <img key={image} src={image} alt="" loading="lazy" />)}</div> : null}
    <MobileCard><dl className="mobile-detail-grid"><div><dt>Product code</dt><dd dir="ltr">{product.sku}</dd></div><div><dt>Barcode</dt><dd dir="ltr">{product.barcode ?? "—"}</dd></div><div><dt>Price</dt><dd>{money(product.selling_price)}</dd></div><div><dt>Availability</dt><dd>{product.active ? "Active" : "Inactive"}</dd></div></dl></MobileCard>
    <h2 className="mobile-section-title">Exact variants · active branch</h2>
    {variants.length ? <div className="mobile-list">{variants.map((variant) => <MobileCard key={variant.id}><div className="mobile-row"><strong>{variantLabel(variant, lang)}</strong><MobileBadge tone={variantStatus(variant) === "out" ? "danger" : variantStatus(variant) === "low" ? "warning" : variantStatus(variant) === "archived" ? "neutral" : "success"}>{variantStatus(variant)}</MobileBadge></div><div className="mobile-row mobile-muted"><span dir="ltr">{variant.sku} · {variant.barcode ?? "—"}</span><strong>{variant.stock_quantity}</strong></div><p>{money(variant.price_override ?? product.selling_price)}</p></MobileCard>)}</div> : <MobileCard><div className="mobile-row"><span>Branch stock</span><strong>{product.stock_quantity}</strong></div></MobileCard>}
    {can("products.edit") ? <Link className="mobile-secondary-link" to={`/products/${product.id}/edit`}>Open authoritative product editor</Link> : null}
  </MobilePage>;
}
