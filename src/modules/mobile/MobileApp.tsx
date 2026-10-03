import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Network } from "@capacitor/network";
import { useAuth } from "@/lib/auth";
import { BranchProvider, useBranch } from "@/lib/branch";
import { can } from "@/lib/permissions/enforce";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { CatalogProvider } from "@/modules/products";
import { InventoryProvider } from "@/modules/inventory";
import { ApprovalProvider, useApprovals } from "@/modules/approvals";
import { OnlineNotificationsProvider, OnlineOrdersProvider, useOnlineOrders } from "@/modules/online";
import { MobileContext } from "./MobileContext";
import { createPushController, deactivateMobileInstallation, type PushController, type PushRegistrationState } from "./services/mobilePush";
import { getMobileRuntime, mobileNetworkState, type MobileNetworkState, type MobileRuntimeContext } from "./services/mobileRuntime";
import { MobileDashboardPage } from "./pages/MobileDashboardPage";
import { MobileOrdersPage, MobileOrderDetailPage } from "./pages/MobileOrdersPages";
import { MobileInventoryPage, MobileProductDetailPage } from "./pages/MobileInventoryPages";
import { MobileInvoicesPage, MobileInvoiceDetailPage } from "./pages/MobileInvoicesPages";
import { MobileApprovalsPage, MobileApprovalDetailPage } from "./pages/MobileApprovalsPages";
import { MobileNotificationsPage } from "./pages/MobileNotificationsPage";
import { MobileHealthPage } from "./pages/MobileHealthPage";
import { MobileMorePage } from "./pages/MobileMorePage";
import "./mobile.css";

export function MobileApp() {
  return <BranchProvider><CatalogProvider><ApprovalProvider><InventoryProvider><OnlineNotificationsProvider><OnlineOrdersProvider><MobileShell /></OnlineOrdersProvider></OnlineNotificationsProvider></InventoryProvider></ApprovalProvider></CatalogProvider></BranchProvider>;
}

function MobileShell() {
  const auth = useAuth();
  const branch = useBranch();
  const approvals = useApprovals();
  const orders = useOnlineOrders();
  const { lang, dir, toggleLang } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [runtime, setRuntime] = useState<MobileRuntimeContext | null>(null);
  const [network, setNetwork] = useState<MobileNetworkState>("unknown");
  const [pushState, setPushState] = useState<PushRegistrationState>("unsupported");
  const push = useRef<PushController | null>(null);

  const refreshNetwork = useCallback(async () => setNetwork(await mobileNetworkState()), []);
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | null = null;
    void getMobileRuntime().then(setRuntime);
    void refreshNetwork();
    void Network.addListener("networkStatusChange", (status) => setNetwork(status.connected ? "online" : "offline")).then((created) => { handle = created; });
    return () => { if (handle) void handle.remove(); };
  }, [refreshNetwork]);
  useEffect(() => {
    let active = true;
    if (!auth.user) return;
    void createPushController(auth.user, navigate, (state) => { if (active) setPushState(state); }).then((controller) => { if (!active) void controller.dispose(); else { push.current = controller; setPushState(controller.state); } });
    return () => { active = false; const current = push.current; push.current = null; if (current) void current.dispose(); };
  }, [auth.user?.id, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  const enablePush = useCallback(async () => { if (push.current) setPushState(await push.current.enable()); }, []);
  const context = useMemo(() => ({ runtime, network, pushState, enablePush, refreshNetwork }), [runtime, network, pushState, enablePush, refreshNetwork]);
  const logout = async () => { if (push.current) await push.current.deactivate(); else await deactivateMobileInstallation(); await auth.signOut(); };
  const tabs = [
    { to: "/mobile", label: "Home", icon: "⌂", show: true },
    { to: "/mobile/orders", label: "Orders", icon: "▤", show: can("orders.view"), badge: orders.counts.pending },
    { to: "/mobile/inventory", label: "Inventory", icon: "◇", show: can("inventory.view") },
    { to: "/mobile/notifications", label: "Alerts", icon: "♢", show: true, badge: approvals.pendingCount + orders.counts.pending },
    { to: "/mobile/more", label: "More", icon: "•••", show: true },
  ].filter((tab) => tab.show);

  return <MobileContext.Provider value={context}>
    <div className="mobile-app" dir={dir} data-mobile-width-safe="360-430">
      <header className="mobile-topbar">
        <div><strong>ALYQ Mobile</strong><span className={`mobile-network mobile-network-${network}`}>{network}</span></div>
        <div className="mobile-top-actions"><button type="button" onClick={toggleLang} aria-label="Change language">{lang === "ar" ? "EN" : "ع"}</button><button type="button" onClick={() => void logout()}>Logout</button></div>
        <label className="mobile-branch"><span>Branch</span><select value={branch.current?.id ?? ""} disabled={branch.loading || branch.switching} onChange={(event) => void branch.switchBranch(event.target.value)}>{branch.branches.map((entry) => <option key={entry.id} value={entry.id}>{lang === "ar" ? entry.name_ar : entry.name_en}</option>)}</select></label>
        {branch.error ? <p className="mobile-top-error">{branch.error}</p> : null}
      </header>
      <main className="mobile-content" id="mobile-main">
        <Routes>
          <Route path="/mobile" element={<MobileDashboardPage />} />
          <Route path="/mobile/orders" element={<MobileOrdersPage />} />
          <Route path="/mobile/orders/:id" element={<MobileOrderDetailPage />} />
          <Route path="/mobile/inventory" element={<MobileInventoryPage />} />
          <Route path="/mobile/inventory/:id" element={<MobileProductDetailPage />} />
          <Route path="/mobile/invoices" element={<MobileInvoicesPage />} />
          <Route path="/mobile/invoices/:id" element={<MobileInvoiceDetailPage />} />
          <Route path="/mobile/approvals" element={<MobileApprovalsPage />} />
          <Route path="/mobile/approvals/:id" element={<MobileApprovalDetailPage />} />
          <Route path="/mobile/notifications" element={<MobileNotificationsPage />} />
          <Route path="/mobile/health" element={<MobileHealthPage />} />
          <Route path="/mobile/more" element={<MobileMorePage />} />
          <Route path="*" element={<Navigate to="/mobile" replace />} />
        </Routes>
      </main>
      <nav className="mobile-bottom-nav" aria-label="Mobile management navigation">{tabs.map((tab) => {
        const active = tab.to === "/mobile" ? location.pathname === tab.to : location.pathname.startsWith(tab.to);
        return <Link key={tab.to} to={tab.to} className={active ? "active" : ""}><span aria-hidden>{tab.icon}</span><small>{tab.label}</small>{tab.badge ? <b>{Math.min(tab.badge, 99)}</b> : null}</Link>;
      })}</nav>
    </div>
  </MobileContext.Provider>;
}
