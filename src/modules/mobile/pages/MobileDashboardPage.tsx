import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { can } from "@/lib/permissions/enforce";
import { useBranch } from "@/lib/branch";
import { useInventory } from "@/modules/inventory";
import { useOnlineOrders } from "@/modules/online";
import { useApprovals } from "@/modules/approvals";
import { computeInventoryAlerts } from "@/modules/dashboard/onlineDashboard";
import { fetchFinancialSummary } from "@/modules/reports/services/reportAggregates";
import { presetRange, toExportRange } from "@/modules/reports/services/dateRanges";
import type { FinancialTotals } from "@/modules/reports/services/financialExport";
import { MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";

export function MobileDashboardPage() {
  const { money, lang } = useI18n();
  const branch = useBranch();
  const inventory = useInventory();
  const orders = useOnlineOrders();
  const approvals = useApprovals();
  const [financial, setFinancial] = useState<FinancialTotals | null>(null);
  const [financialError, setFinancialError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const range = useMemo(() => toExportRange(presetRange("today")), []);

  const loadFinancial = async () => {
    if (!can("reports.view")) return;
    const result = await fetchFinancialSummary(range);
    if (result.ok) { setFinancial(result.value); setFinancialError(null); }
    else setFinancialError(result.reason);
  };

  useEffect(() => { void loadFinancial(); }, [branch.current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const alerts = useMemo(
    () => computeInventoryAlerts(inventory.products, inventory.variantsByProduct, lang),
    [inventory.products, inventory.variantsByProduct, lang],
  );

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadFinancial(), inventory.refresh(), orders.refresh(), approvals.refresh()]);
    setRefreshing(false);
  };

  return <MobilePage
    title="Management overview"
    subtitle={branch.current ? `${branch.current.code} · ${lang === "ar" ? branch.current.name_ar : branch.current.name_en}` : "No active branch"}
    actions={<button type="button" className="mobile-action" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>}
  >
    {!branch.current && !branch.loading ? <MobileState kind="denied" title="No authorized branch" detail="Select an active branch membership before viewing management data." /> : null}
    {can("reports.view") ? <>
      {financialError ? <MobileState kind="error" title="Dashboard totals unavailable" detail={financialError} retry={() => void loadFinancial()} /> : null}
      <div className="mobile-kpi-grid" aria-label="Authoritative financial KPIs">
        <MobileCard><span>Today sales</span><strong>{financial ? money(financial.revenue) : "—"}</strong></MobileCard>
        <MobileCard><span>Net sales</span><strong>{financial ? money(financial.revenue - financial.refundsPaid) : "—"}</strong></MobileCard>
        <MobileCard><span>Invoices</span><strong>{financial?.invoiceCount ?? "—"}</strong></MobileCard>
        <MobileCard><span>Average order</span><strong>{financial && financial.invoiceCount ? money(financial.revenue / financial.invoiceCount) : financial ? money(0) : "—"}</strong></MobileCard>
        <MobileCard><span>Refunds paid</span><strong>{financial ? money(financial.refundsPaid) : "—"}</strong></MobileCard>
        <MobileCard><span>Returns</span><strong>{financial?.returnsCount ?? "—"}</strong></MobileCard>
      </div>
      {financial ? <MobileCard className="mobile-payment-card">
        <h2>Payment distribution</h2>
        <dl><div><dt>Cash</dt><dd>{money(financial.cash)}</dd></div><div><dt>Card</dt><dd>{money(financial.card)}</dd></div><div><dt>InstaPay</dt><dd>{money(financial.instapay)}</dd></div></dl>
      </MobileCard> : null}
    </> : <MobileState kind="denied" title="Financial dashboard unavailable" detail="Your current branch role does not include report access." />}

    <div className="mobile-summary-grid">
      {can("orders.view") ? <Link to="/mobile/orders" className="mobile-summary-link"><strong>{orders.counts.pending}</strong><span>Orders awaiting review</span></Link> : null}
      {can("inventory.view") ? <Link to="/mobile/inventory?status=low" className="mobile-summary-link"><strong>{alerts.lowCount}</strong><span>Low stock variants</span></Link> : null}
      {can("inventory.view") ? <Link to="/mobile/inventory?status=out" className="mobile-summary-link"><strong>{alerts.outCount}</strong><span>Out of stock</span></Link> : null}
      {can("approvals.approve") ? <Link to="/mobile/approvals" className="mobile-summary-link"><strong>{approvals.pendingCount}</strong><span>Pending approvals</span></Link> : null}
    </div>
  </MobilePage>;
}
