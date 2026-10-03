import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Preferences } from "@capacitor/preferences";
import { capabilitiesOfUser } from "@/lib/permissions/enforce";
import { useAuth } from "@/lib/auth";
import { useInventory } from "@/modules/inventory";
import { useOnlineOrders } from "@/modules/online";
import { useApprovals } from "@/modules/approvals";
import { buildOperationalNotifications, markAllNotificationsRead, markNotificationRead, type NotificationSnapshot } from "@/modules/operations/services/notifications";
import { variantLabel } from "@/modules/products/variants";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { MobileBadge, MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";
import { useMobile } from "../MobileContext";

const READ_KEY = "alyq.mobile.notifications.read.v1";

export function MobileNotificationsPage() {
  const auth = useAuth();
  const { lang } = useI18n();
  const inventory = useInventory();
  const orders = useOnlineOrders();
  const approvals = useApprovals();
  const mobile = useMobile();
  const navigate = useNavigate();
  const [readIds, setReadIds] = useState<string[]>([]);
  useEffect(() => { void Preferences.get({ key: READ_KEY }).then(({ value }) => { try { setReadIds(value ? JSON.parse(value) as string[] : []); } catch { setReadIds([]); } }); }, []);
  const saveRead = (ids: string[]) => { setReadIds(ids); void Preferences.set({ key: READ_KEY, value: JSON.stringify(ids.slice(-500)) }); };

  const snapshot = useMemo<NotificationSnapshot>(() => ({
    stock: inventory.products.flatMap((product) => {
      const variants = inventory.variantsByProduct.get(product.id) ?? [];
      return variants.length ? variants.map((variant) => ({ id: `${product.id}:${variant.id}`, quantity: variant.stock_quantity, lowLevel: variant.low_stock_level, tracked: product.stock_tracking_enabled, active: product.active && variant.active, updatedAt: variant.updated_at, label: `${lang === "ar" ? product.name_ar : product.name_en} · ${variantLabel(variant, lang)}` }))
        : [{ id: product.id, quantity: product.stock_quantity, lowLevel: product.low_stock_level, tracked: product.stock_tracking_enabled, active: product.active, updatedAt: product.updated_at, label: lang === "ar" ? product.name_ar : product.name_en }];
    }),
    orders: orders.orders.map((order) => ({ id: order.id, number: order.order_number, status: order.status, createdAt: order.created_at })),
    returns: [], shifts: [], promotions: [], stocktakes: [],
    approvals: approvals.requests.map((request) => ({ id: request.id, number: request.request_number, status: request.status, requestedAt: request.requested_at })),
    backupStatus: null, backupAt: null, storageUsedBytes: null, storageWarningBytes: null,
    supabase: mobile.network === "offline" ? "unavailable" : "ok",
  }), [inventory.products, inventory.variantsByProduct, orders.orders, approvals.requests, mobile.network, lang]);

  const capabilities = useMemo(() => new Set(capabilitiesOfUser(auth.user)), [auth.user]);
  const notifications = useMemo(() => buildOperationalNotifications(snapshot, capabilities, new Date().toISOString(), new Set(readIds)), [snapshot, capabilities, readIds]);

  const open = (note: typeof notifications[number]) => {
    saveRead(markNotificationRead(readIds, note.id));
    if (note.kind === "online_order") navigate(`/mobile/orders/${note.entityId}`);
    else if (note.kind === "approval_request") navigate(`/mobile/approvals/${note.entityId}`);
    else if (note.kind === "low_stock" || note.kind === "out_of_stock") navigate(`/mobile/inventory/${note.entityId.split(":")[0]}`);
    else if (note.kind === "return_pending") navigate("/mobile/invoices");
    else navigate("/mobile/health");
  };

  return <MobilePage title="Notifications" subtitle="Deduplicated operational attention" actions={notifications.length ? <button type="button" className="mobile-action" onClick={() => saveRead(markAllNotificationsRead(readIds, notifications))}>Mark all read</button> : null}>
    <MobileCard className="mobile-push-card"><div className="mobile-row"><div><strong>Native notifications</strong><p className="mobile-muted">{mobile.pushState.replace(/_/g, " ")}</p></div><MobileBadge tone={mobile.pushState === "registered" ? "success" : mobile.pushState === "error" || mobile.pushState === "denied" ? "warning" : "neutral"}>{mobile.pushState}</MobileBadge></div>{mobile.pushState === "not_requested" ? <button type="button" className="mobile-primary-button" onClick={() => void mobile.enablePush()}>Enable notifications</button> : null}</MobileCard>
    {notifications.length === 0 ? <MobileState kind="empty" title="Nothing needs attention" /> : <div className="mobile-list">{notifications.map((note) => <button type="button" className={`mobile-notification ${note.read ? "read" : ""}`} key={note.id} onClick={() => open(note)}><span className="mobile-notification-dot" /><span><strong>{note.kind.replace(/_/g, " ")}</strong><small>{note.label} · {new Date(note.at).toLocaleString()}</small></span></button>)}</div>}
    <p className="mobile-privacy-note">Lock-screen payloads contain only a safe event type and reference, never customer phone, address, payment details, PINs, or credentials.</p>
  </MobilePage>;
}
