import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/AppShell";
import { Button, Card, EmptyState, TextInput, useToast } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useInventory } from "../hooks/InventoryProvider";
import { useBarcodeScanner } from "@/modules/pos/hooks/useBarcodeScanner";
import { adjustStockToCount } from "../services/inventoryService";
import { createStocktake, listStocktakes, markFinalized, moveToReview, saveStocktake, scanStocktake, updateCount, type StocktakeSession } from "../services/stocktake";

export function StocktakePage() {
  const { t, pick, num } = useI18n();
  const statusLabel = (status: StocktakeSession["status"]) => ({ draft: t("inventory.stocktake.status.draft"), counting: t("inventory.stocktake.status.counting"), review: t("inventory.stocktake.status.review"), finalized: t("inventory.stocktake.status.finalized") })[status];
  const { products, variants, refresh, user, canAdjust } = useInventory();
  const toast = useToast();
  const [session, setSession] = useState<StocktakeSession | null>(null);
  const [history, setHistory] = useState(() => listStocktakes());
  const [blind, setBlind] = useState(false);
  const [busy, setBusy] = useState(false);
  const productById = useMemo(() => new Map(products.map((item) => [item.id, item])), [products]);

  const scan = (code: string) => {
    if (!session || session.status === "finalized") return;
    const next = scanStocktake(session, code);
    if (next !== session) { setSession(next); saveStocktake(next); }
  };
  useBarcodeScanner(scan);

  const start = () => {
    const next = createStocktake(products, variants, user.name, blind);
    setSession(next); setHistory(listStocktakes());
  };
  const update = (index: number, value: string) => {
    if (!session) return;
    const next = updateCount(session, index, Number(value) || 0);
    setSession(next); saveStocktake(next);
  };
  const review = () => {
    if (!session) return;
    const next = moveToReview(session);
    if (next.status !== "review") { toast.error(t("inventory.stocktake.completeCounts")); return; }
    setSession(next); saveStocktake(next);
  };
  const finalize = async () => {
    if (!session || session.status !== "review" || !canAdjust) return;
    setBusy(true);
    try {
      const refs = new Map<number, string>();
      for (let index = 0; index < session.rows.length; index += 1) {
        const row = session.rows[index];
        if (row.physicalQuantity === null || row.physicalQuantity === row.systemQuantity) continue;
        const result = await adjustStockToCount({ productId: row.productId, variantId: row.variantId, physicalQuantity: row.physicalQuantity, notes: `Stocktake ${session.id}` });
        refs.set(index, result.movement.id);
      }
      const next = markFinalized(session, user.name, refs);
      saveStocktake(next); setSession(next); setHistory(listStocktakes()); await refresh({ silent: true });
      toast.success(t("inventory.stocktake.finalized"));
    } catch { toast.error(t("inventory.stocktake.finalizeFailed")); }
    finally { setBusy(false); }
  };

  return <div>
    <PageHeader crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("nav.inventory") }]} title={t("inventory.stocktake.title")} subtitle={t("inventory.stocktake.subtitle")} actions={
      <div className="flex flex-wrap gap-2"><Button onClick={start} disabled={!canAdjust || session?.status === "review" || session?.status === "finalized"}>{t("inventory.stocktake.new")}</Button>{session?.status === "counting" || session?.status === "draft" ? <Button variant="secondary" onClick={review}>{t("inventory.stocktake.review")}</Button> : null}{session?.status === "review" ? <Button onClick={() => void finalize()} loading={busy}>{t("inventory.stocktake.finalize")}</Button> : null}</div>
    } />
    <Card className="mb-4 p-4"><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={blind} onChange={(event) => setBlind(event.target.checked)} disabled={Boolean(session)} />{t("inventory.stocktake.blind")}</label><p className="mt-1 text-xs text-slate-500">{t("inventory.stocktake.scanHint")}</p></Card>
    {session ? <Card className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><span className="text-sm font-bold">{session.id} · {statusLabel(session.status)}</span><span className="text-xs text-slate-500">{session.createdBy} · {new Date(session.createdAt).toLocaleString()}</span></div><div className="overflow-x-auto"><table className="min-w-[850px] w-full text-sm"><thead className="bg-slate-50 text-start"><tr>{[t("inventory.stocktake.product"), t("inventory.stocktake.variant"), t("inventory.stocktake.sku"), t("inventory.stocktake.barcode"), t("inventory.stocktake.system"), t("inventory.stocktake.physical"), t("inventory.stocktake.variance")].map((label) => <th key={label} className="px-3 py-3 text-start">{label}</th>)}</tr></thead><tbody>{session.rows.map((row, index) => { const product = productById.get(row.productId); return <tr key={`${row.productId}-${row.variantId ?? "base"}`} className="border-t border-slate-100"><td className="px-3 py-3 font-semibold">{product ? pick(product.name_ar, product.name_en) : row.productNameEn}</td><td className="px-3 py-3">{row.variantLabel || "—"}</td><td className="px-3 py-3 font-mono text-xs">{row.sku}</td><td className="px-3 py-3 font-mono text-xs">{row.barcode ?? "—"}</td><td className="px-3 py-3">{session.blind && session.status === "counting" ? "—" : num(row.systemQuantity)}</td><td className="px-3 py-3"><TextInput aria-label={`${row.sku} physical`} type="number" min="0" value={row.physicalQuantity === null ? "" : String(row.physicalQuantity)} disabled={session.status === "finalized" || session.status === "review"} onChange={(event) => update(index, event.target.value)} className="w-24" /></td><td className={`px-3 py-3 font-bold ${row.variance === null ? "text-slate-400" : row.variance < 0 ? "text-red-600" : row.variance > 0 ? "text-emerald-600" : "text-slate-600"}`}>{session.status === "counting" && session.blind ? "—" : row.variance === null ? "—" : `${row.variance > 0 ? "+" : ""}${row.variance}`}</td></tr>; })}</tbody></table></div></Card> : <EmptyState title={t("inventory.stocktake.empty")} description={t("inventory.stocktake.emptyHint")} />}
    {history.length > 0 ? <Card className="mt-4 p-4"><h2 className="font-black">{t("inventory.stocktake.history")}</h2><div className="mt-3 flex flex-wrap gap-2">{history.slice(0, 8).map((item) => <button key={item.id} className="rounded-lg border border-slate-200 px-3 py-2 text-start text-xs" onClick={() => setSession(item)}>{item.id}<br /><span className="text-slate-500">{item.status} · {item.rows.length} {t("inventory.stocktake.rows")}</span></button>)}</div></Card> : null}
  </div>;
}
