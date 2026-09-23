import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/AppShell";
import { Button, Card, EmptyState, TextInput, useToast } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { AppError } from "@/modules/products/data/repository";
import { useBarcodeScanner } from "@/modules/pos/hooks/useBarcodeScanner";
import { useInventory } from "../hooks/InventoryProvider";
import {
  finalizeStocktake,
  listStocktakeSessions,
  persistStocktakeCounts,
  reviewStocktake,
  startStocktake,
} from "../services/stocktakeService";
import { scanStocktake, updateCount, type StocktakeSession } from "../services/stocktake";

export function StocktakePage() {
  const { t, pick, num } = useI18n();
  const statusLabel = (status: StocktakeSession["status"]) =>
    ({
      draft: t("inventory.stocktake.status.draft"),
      counting: t("inventory.stocktake.status.counting"),
      review: t("inventory.stocktake.status.review"),
      finalized: t("inventory.stocktake.status.finalized"),
    })[status];
  const { products, variants, refresh, user, canAdjust, mode } = useInventory();
  const toast = useToast();
  const [session, setSession] = useState<StocktakeSession | null>(null);
  const [history, setHistory] = useState<StocktakeSession[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [blind, setBlind] = useState(false);
  const [busy, setBusy] = useState(false);
  const productById = useMemo(() => new Map(products.map((item) => [item.id, item])), [products]);
  const persistQueue = useRef(Promise.resolve());
  const sessionRef = useRef<StocktakeSession | null>(null);
  sessionRef.current = session;

  const reloadHistory = async () => {
    const rows = await listStocktakeSessions();
    setHistory(rows);
    return rows;
  };

  useEffect(() => {
    let cancelled = false;
    listStocktakeSessions()
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch(() => {
        if (!cancelled) {
          setHistory([]);
          setHistoryFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enqueuePersist = (next: StocktakeSession) => {
    persistQueue.current = persistQueue.current
      .then(async () => {
        await persistStocktakeCounts(next);
      })
      .catch(() => {
        toast.error(t("inventory.stocktake.saveFailed"));
      });
  };

  const scan = (code: string) => {
    const current = sessionRef.current;
    if (!current || current.status === "finalized" || current.status === "review") return;
    const next = scanStocktake(current, code);
    if (next === current) return;
    setSession(next);
    enqueuePersist(next);
  };
  useBarcodeScanner(scan);

  const start = async () => {
    if (!canAdjust) return;
    setBusy(true);
    try {
      const next = await startStocktake({ products, variants, createdBy: user.name, blind });
      setSession(next);
      setHistory(await listStocktakeSessions());
    } catch (error) {
      toast.error(error instanceof AppError && error.code === "VALIDATION" ? t("inventory.stocktake.emptyCatalogue") : t("inventory.stocktake.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const update = (index: number, value: string) => {
    if (!session || session.status === "finalized" || session.status === "review") return;
    const next = updateCount(session, index, value === "" ? 0 : Number(value));
    setSession(next);
    enqueuePersist(next);
  };

  const review = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await persistQueue.current;
      const next = await reviewStocktake(sessionRef.current ?? session);
      setSession(next);
      setHistory(await listStocktakeSessions());
    } catch (error) {
      toast.error(error instanceof AppError && error.code === "STOCKTAKE_INCOMPLETE" ? t("inventory.stocktake.completeCounts") : t("inventory.stocktake.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const finalize = async () => {
    if (!session || session.status !== "review" || !canAdjust) return;
    setBusy(true);
    try {
      await persistQueue.current;
      const next = await finalizeStocktake(session.id);
      setSession(next);
      setHistory(await listStocktakeSessions());
      await refresh({ silent: true });
      toast.success(t("inventory.stocktake.finalized"));
    } catch (error) {
      if (error instanceof AppError && error.code === "STOCKTAKE_CONFLICT") {
        toast.error(`${t("inventory.stocktake.conflict")} ${error.message}`.trim());
        return;
      }
      toast.error(error instanceof AppError && error.code === "STOCKTAKE_INCOMPLETE" ? t("inventory.stocktake.incomplete") : t("inventory.stocktake.finalizeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async (item: StocktakeSession) => {
    try {
      const rows = await reloadHistory();
      setSession(rows.find((row) => row.id === item.id) ?? item);
    } catch {
      toast.error(t("inventory.stocktake.loadFailed"));
    }
  };

  return (
    <div>
      <PageHeader
        crumbs={[{ label: t("home.management.title"), to: "/management" }, { label: t("nav.inventory") }]}
        title={t("inventory.stocktake.title")}
        subtitle={t("inventory.stocktake.subtitle")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void start()} disabled={!canAdjust || busy || session?.status === "review" || session?.status === "finalized"} loading={busy && !session}>
              {t("inventory.stocktake.new")}
            </Button>
            {session?.status === "counting" || session?.status === "draft" ? (
              <Button variant="secondary" onClick={() => void review()} disabled={busy}>{t("inventory.stocktake.review")}</Button>
            ) : null}
            {session?.status === "review" && canAdjust ? (
              <Button onClick={() => void finalize()} loading={busy}>{t("inventory.stocktake.finalize")}</Button>
            ) : null}
          </div>
        }
      />
      <Card className="mb-4 p-4">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={blind} onChange={(event) => setBlind(event.target.checked)} disabled={Boolean(session)} />
          {t("inventory.stocktake.blind")}
        </label>
        <p className="mt-1 text-xs text-slate-500">{t("inventory.stocktake.scanHint")}</p>
        <p className="mt-2 text-xs font-semibold text-slate-600">
          {mode === "supabase" ? t("inventory.stocktake.liveNote") : t("inventory.stocktake.demoNote")}
        </p>
      </Card>
      {session ? (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4">
            <span className="text-sm font-bold">{session.reference} · {statusLabel(session.status)}</span>
            <span className="text-xs text-slate-500">{session.createdBy} · {new Date(session.createdAt).toLocaleString()}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[850px] w-full text-sm">
              <thead className="bg-slate-50 text-start">
                <tr>
                  {[t("inventory.stocktake.product"), t("inventory.stocktake.variant"), t("inventory.stocktake.sku"), t("inventory.stocktake.barcode"), t("inventory.stocktake.system"), t("inventory.stocktake.physical"), t("inventory.stocktake.variance")].map((label) => (
                    <th key={label} className="px-3 py-3 text-start">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {session.rows.map((row, index) => {
                  const product = productById.get(row.productId);
                  return (
                    <tr key={row.lineId} className="border-t border-slate-100">
                      <td className="px-3 py-3 font-semibold">{product ? pick(product.name_ar, product.name_en) : pick(row.productNameAr, row.productNameEn)}</td>
                      <td className="px-3 py-3">{row.variantLabel || "—"}</td>
                      <td className="px-3 py-3 font-mono text-xs">{row.sku}</td>
                      <td className="px-3 py-3 font-mono text-xs">{row.barcode ?? "—"}</td>
                      <td className="px-3 py-3">{session.blind && session.status === "counting" ? "—" : num(row.systemQuantity)}</td>
                      <td className="px-3 py-3">
                        <TextInput
                          aria-label={`${row.sku} physical`}
                          type="number"
                          min="0"
                          value={row.physicalQuantity === null ? "" : String(row.physicalQuantity)}
                          disabled={session.status === "finalized" || session.status === "review"}
                          onChange={(event) => update(index, event.target.value)}
                          className="w-24"
                        />
                      </td>
                      <td className={`px-3 py-3 font-bold ${row.variance === null ? "text-slate-400" : row.variance < 0 ? "text-red-600" : row.variance > 0 ? "text-emerald-600" : "text-slate-600"}`}>
                        {session.status === "counting" && session.blind ? "—" : row.variance === null ? "—" : `${row.variance > 0 ? "+" : ""}${row.variance}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <EmptyState title={t("inventory.stocktake.empty")} description={t("inventory.stocktake.emptyHint")} />
      )}
      {historyFailed ? <p className="mt-4 text-sm font-semibold text-red-700">{t("inventory.stocktake.loadFailed")}</p> : null}
      {history.length > 0 ? (
        <Card className="mt-4 p-4">
          <h2 className="font-black">{t("inventory.stocktake.history")}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {history.slice(0, 8).map((item) => (
              <button key={item.id} className="rounded-lg border border-slate-200 px-3 py-2 text-start text-xs" onClick={() => void openHistory(item)}>
                {item.reference}
                <br />
                <span className="text-slate-500">{item.status} · {item.rows.length} {t("inventory.stocktake.rows")}</span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
