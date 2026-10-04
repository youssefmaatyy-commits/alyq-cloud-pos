import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { can } from "@/lib/permissions/enforce";
import { getSalesRepository } from "@/modules/pos/data";
import type { Sale } from "@/modules/pos/types";
import { EMPTY_TRANSACTION_FILTERS, searchTransactionCenter, type TransactionCenterResult } from "@/modules/pos/services/transactionCenter";
import { getReturnRepository } from "@/modules/returns/data";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { MobileBadge, MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";

async function demoEvidence() {
  if (isSupabaseConfigured) return { sales: [], returns: [], refunds: [] };
  const salesRepository = getSalesRepository();
  const returnsRepository = getReturnRepository();
  const [sales, returns, refunds] = await Promise.all([salesRepository.listSales({ limit: 100 }), returnsRepository.listReturns(), returnsRepository.listRefunds()]);
  return { sales, returns, refunds };
}

export function MobileInvoicesPage() {
  const { money } = useI18n();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TransactionCenterResult | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [page, setPage] = useState(1);

  const search = async (nextPage = page) => {
    if (!can("sales.view")) return;
    setState("loading");
    try {
      const evidence = await demoEvidence();
      setResult(await searchTransactionCenter({ ...EMPTY_TRANSACTION_FILTERS, query, page: nextPage, pageSize: 20 }, evidence));
      setPage(nextPage); setState("idle");
    } catch { setState("error"); }
  };
  useEffect(() => { const timer = window.setTimeout(() => void search(1), 350); return () => window.clearTimeout(timer); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!can("sales.view")) return <MobilePage title="Invoices"><MobileState kind="denied" title="Invoice access denied" /></MobilePage>;
  return <MobilePage title="Invoices & returns" subtitle="Server-side active-branch search">
    <div className="mobile-filter-row"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Invoice, customer, phone, cashier, product, SKU or barcode" aria-label="Search invoices" /></div>
    {state === "loading" && !result ? <MobileState kind="loading" title="Searching invoices…" /> : null}
    {state === "error" ? <MobileState kind="error" title="Invoice search unavailable" retry={() => void search()} /> : null}
    {result?.rows.length === 0 ? <MobileState kind="empty" title="No matching invoices" /> : <div className="mobile-list">{result?.rows.map((row) => <Link className="mobile-list-link" key={row.id} to={`/mobile/invoices/${row.id}`}><MobileCard><div className="mobile-row"><strong>{row.sale_number}</strong><MobileBadge tone={row.status === "voided" ? "danger" : "success"}>{row.status}</MobileBadge></div><p>{row.customer_name ?? "Walk-in customer"}</p><div className="mobile-row mobile-muted"><span>{row.branch_code ?? "—"} · {row.cashier_name}</span><strong>{money(row.total)}</strong></div><div className="mobile-row mobile-muted"><span>{row.payment_methods.join(" + ")}</span><span>{row.returns.length} returns · {row.refunds.length} refunds</span></div></MobileCard></Link>)}</div>}
    {result && result.page_count > 1 ? <div className="mobile-pagination"><button disabled={page <= 1 || state === "loading"} onClick={() => void search(page - 1)}>Previous</button><span>{page} / {result.page_count}</span><button disabled={page >= result.page_count || state === "loading"} onClick={() => void search(page + 1)}>Next</button></div> : null}
  </MobilePage>;
}

export function MobileInvoiceDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { money, lang } = useI18n();
  const repository = useMemo(() => getSalesRepository(), []);
  const returnsRepository = useMemo(() => getReturnRepository(), []);
  const [sale, setSale] = useState<Sale | null>(null);
  const [returnsCount, setReturnsCount] = useState(0);
  const [refundSummary, setRefundSummary] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "denied">("loading");
  useEffect(() => {
    let active = true;
    if (!can("sales.view") || !id) { setState("denied"); return; }
    void Promise.all([repository.getSale(id), returnsRepository.getReturnsForSale(id), returnsRepository.getRefundsForSale(id)])
      .then(([found, returns, refunds]) => { if (!active) return; setSale(found); setReturnsCount(returns.length); setRefundSummary(refunds.map((refund) => `${refund.refund_number}: ${refund.status}`).join(" · ")); setState("ready"); })
      .catch(() => { if (active) setState("denied"); });
    return () => { active = false; };
  }, [id, repository, returnsRepository]);

  return <MobilePage title={sale?.sale_number ?? "Invoice detail"} subtitle="Stored historical evidence" actions={<button type="button" className="mobile-action" onClick={() => navigate(-1)}>Back</button>}>
    {state === "loading" ? <MobileState kind="loading" title="Loading invoice…" /> : null}
    {state === "denied" ? <MobileState kind="denied" title="Access denied or invoice unavailable" detail="The invoice is not available in your active authorized branch." /> : null}
    {sale ? <>
      <MobileCard><dl className="mobile-detail-grid"><div><dt>Branch</dt><dd>{sale.branch_name ?? "—"}</dd></div><div><dt>Date</dt><dd>{new Date(sale.created_at).toLocaleString()}</dd></div><div><dt>Cashier</dt><dd>{sale.user_name}</dd></div><div><dt>Register</dt><dd>{sale.register_name ?? "—"}</dd></div><div><dt>Shift</dt><dd>{sale.shift_id ?? "—"}</dd></div><div><dt>Customer</dt><dd>{sale.customer_name ?? "Walk-in"}</dd></div></dl></MobileCard>
      <h2 className="mobile-section-title">Items</h2><div className="mobile-list">{sale.items.map((item) => <MobileCard key={item.id}><strong>{lang === "ar" ? item.name_ar : item.name_en}</strong><p>{[lang === "ar" ? item.variant_color_ar : item.variant_color_en, item.variant_size_label ?? item.variant_size].filter(Boolean).join(" / ") || "—"}</p><div className="mobile-row mobile-muted"><span dir="ltr">{item.sku} · {item.barcode ?? "—"}</span><span>{item.quantity} × {money(item.unit_price)}</span></div>{item.automatic_promotion_name ? <p>{item.automatic_promotion_name}</p> : null}</MobileCard>)}</div>
      <MobileCard><dl className="mobile-detail-grid"><div><dt>Subtotal</dt><dd>{money(sale.subtotal)}</dd></div><div><dt>Discount</dt><dd>{money(sale.total_discount_amount ?? sale.discount_amount)}</dd></div><div><dt>Total</dt><dd><strong>{money(sale.total)}</strong></dd></div><div><dt>Payments</dt><dd>{sale.payments.map((payment) => `${payment.method} ${money(payment.amount)}`).join(" · ")}</dd></div><div><dt>Returns</dt><dd>{returnsCount}</dd></div><div><dt>Refunds</dt><dd>{refundSummary || "None"}</dd></div></dl></MobileCard>
    </> : null}
  </MobilePage>;
}
