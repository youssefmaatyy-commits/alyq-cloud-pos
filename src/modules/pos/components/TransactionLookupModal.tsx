import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useReturns } from "@/modules/returns/hooks/ReturnProvider";
import { usePos } from "../hooks/PosProvider";

/**
 * Read-only transaction finder for the register. It intentionally reuses the
 * already-authoritative sale/return/refund records and opens their existing
 * detail pages: no duplicate void, refund or return rules live in this panel.
 *
 * Sales are the current history window (normally the most recent cap); returns
 * and refunds are the existing loaded service lists. The disclosure is part of
 * the UI so a local filter is never represented as an unbounded database search.
 */
export function TransactionLookupModal({ onClose }: { onClose: () => void }) {
  const { t, pick, num } = useI18n();
  const navigate = useNavigate();
  const { sales, salesTruncated } = usePos();
  const { returnsList, refundsList } = useReturns();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const needle = query.trim().toLocaleLowerCase();
  const includes = useCallback(
    (value: string | null | undefined) => Boolean(value?.toLocaleLowerCase().includes(needle)),
    [needle],
  );
  const saleResults = useMemo(() => {
    if (!needle) return [];
    return sales.filter((sale) =>
      includes(sale.sale_number) || includes(sale.customer_name) || includes(sale.customer_phone) ||
      includes(sale.client_ref) || sale.items.some((item) =>
        includes(item.name_ar) || includes(item.name_en) || includes(item.sku) || includes(item.barcode),
      ),
    ).slice(0, 20);
  }, [includes, needle, sales]);
  const returnResults = useMemo(() => {
    if (!needle) return [];
    return returnsList.filter((record) =>
      includes(record.return_number) || includes(record.sale_number) || includes(record.customer_name) ||
      record.items.some((item) => includes(item.name_ar) || includes(item.name_en) || includes(item.sku) || includes(item.barcode)),
    ).slice(0, 20);
  }, [includes, needle, returnsList]);
  const refundResults = useMemo(() => {
    if (!needle) return [];
    return refundsList.filter((record) =>
      includes(record.refund_number) || includes(record.sale_number) || includes(record.reason),
    ).slice(0, 20);
  }, [includes, needle, refundsList]);
  const resultCount = saleResults.length + returnResults.length + refundResults.length;
  const open = (to: string) => {
    onClose();
    navigate(to);
  };

  return <div className="fixed inset-0 z-[80] grid place-items-start overflow-y-auto bg-slate-950/45 px-3 py-8 backdrop-blur-sm sm:place-items-center" role="presentation" onMouseDown={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="transaction-lookup-title" onMouseDown={(event) => event.stopPropagation()}
      className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-5">
        <div>
          <h2 id="transaction-lookup-title" className="text-base font-black text-slate-900">{t("pos.lookupTitle")}</h2>
          <p className="mt-1 text-xs font-medium text-slate-500">{t("pos.lookupHint")}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("common.close")}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-lg text-slate-600 hover:bg-slate-100">×</button>
      </header>
      <div className="p-4 sm:p-5">
        <label className="relative block">
          <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-base" aria-hidden>⌕</span>
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t("pos.lookupPlaceholder")}
            className="h-12 w-full rounded-xl border border-slate-300 bg-white py-2 pe-3 ps-10 text-sm font-semibold outline-none transition placeholder:font-medium placeholder:text-slate-400 focus:border-slate-700 focus:ring-2 focus:ring-slate-900/10" />
        </label>
        {salesTruncated ? <p className="mt-2 text-xs font-medium text-amber-700">{t("pos.lookupRecentWindow")}</p> : null}
        {!needle ? <p className="py-10 text-center text-sm font-medium text-slate-500">{t("pos.lookupHint")}</p> : null}
        {needle && resultCount === 0 ? <p className="py-10 text-center text-sm font-medium text-slate-500">{t("pos.lookupNoResults")}</p> : null}
        {needle && resultCount > 0 ? <div className="mt-4 max-h-[60vh] space-y-4 overflow-y-auto pe-1">
          {saleResults.length ? <ResultGroup title={t("pos.lookupSale")}>
            {saleResults.map((sale) => <ResultRow key={sale.id} label={sale.sale_number}
              detail={[sale.customer_name, sale.customer_phone, sale.items.map((item) => pick(item.name_ar, item.name_en)).slice(0, 2).join(" · ")].filter(Boolean).join(" · ")}
              amount={num(sale.total, 2)} status={sale.status} action={t("pos.lookupOpenSale")} onOpen={() => open(`/pos/sales/${sale.id}`)} />)}
          </ResultGroup> : null}
          {returnResults.length ? <ResultGroup title={t("pos.lookupReturn")}>
            {returnResults.map((record) => <ResultRow key={record.id} label={record.return_number}
              detail={`${record.sale_number}${record.customer_name ? ` · ${record.customer_name}` : ""}`}
              amount={num(record.refund_amount, 2)} status={record.refund_status} action={t("pos.lookupOpenReturn")} onOpen={() => open(`/returns/${record.id}`)} />)}
          </ResultGroup> : null}
          {refundResults.length ? <ResultGroup title={t("pos.lookupRefund")}>
            {refundResults.map((record) => <ResultRow key={record.id} label={record.refund_number}
              detail={record.sale_number} amount={num(record.amount, 2)} status={record.status}
              action={t("pos.lookupOpenRefund")} onOpen={() => open(`/refunds/${record.id}`)} />)}
          </ResultGroup> : null}
        </div> : null}
      </div>
    </section>
  </div>;
}

function ResultGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section><h3 className="mb-2 text-xs font-black uppercase tracking-wider text-slate-500">{title}</h3><div className="space-y-2">{children}</div></section>;
}

function ResultRow({ label, detail, amount, status, action, onOpen }: {
  label: string; detail: string; amount: string; status: string; action: string; onOpen: () => void;
}) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5">
    <div className="min-w-0 flex-1"><strong className="block font-mono text-sm text-slate-900" dir="ltr">{label}</strong><span className="block truncate text-xs font-medium text-slate-500">{detail}</span></div>
    <span className="text-sm font-black tabular-nums text-slate-900" dir="ltr">{amount}</span>
    <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold text-slate-600 ring-1 ring-slate-200">{status}</span>
    <button type="button" onClick={onOpen} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-700">{action}</button>
  </div>;
}
