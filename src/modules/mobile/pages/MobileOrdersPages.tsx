import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { can } from "@/lib/permissions/enforce";
import { useOnlineOrders } from "@/modules/online";
import { getOnlineOrdersRepository } from "@/modules/online/data";
import type { OnlineOrder, OrderAction } from "@/modules/online/types";
import { deliveryStatusOf, requiresReason } from "@/modules/online/services/orderWorkflow";
import { requireMobileOnline } from "../services/mobileRuntime";
import { MobileBadge, MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";

const tones = { pending: "warning", approved: "info", processing: "info", ready: "success", completed: "success", cancelled: "danger" } as const;

export function MobileOrdersPage() {
  const { money } = useI18n();
  const context = useOnlineOrders();
  const [query, setQuery] = useState(context.filter.search);

  useEffect(() => {
    const timer = window.setTimeout(() => context.setFilter({ search: query, limit: 50 }), 300);
    return () => window.clearTimeout(timer);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!can("orders.view")) return <MobilePage title="Orders"><MobileState kind="denied" title="Orders access denied" /></MobilePage>;
  return <MobilePage title="Online orders" subtitle="Authoritative branch queue" actions={<button className="mobile-action" type="button" onClick={() => void context.refresh()}>Refresh</button>}>
    <div className="mobile-filter-row">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Order, customer or phone" aria-label="Search online orders" />
      <select value={context.filter.status} onChange={(event) => context.setFilter({ status: event.target.value as typeof context.filter.status })} aria-label="Order status">
        {(["all", "pending", "approved", "processing", "ready", "completed", "cancelled"] as const).map((status) => <option key={status} value={status}>{status}</option>)}
      </select>
    </div>
    {context.loading ? <MobileState kind="loading" title="Loading orders…" />
      : context.error ? <MobileState kind="error" title="Orders unavailable" detail={context.error.message} retry={() => void context.refresh()} />
        : context.orders.length === 0 ? <MobileState kind="empty" title="No matching orders" />
          : <div className="mobile-list">{context.orders.map((order) => <Link className="mobile-list-link" to={`/mobile/orders/${order.id}`} key={order.id}>
            <MobileCard>
              <div className="mobile-row"><strong>{order.order_number}</strong><MobileBadge tone={tones[order.status]}>{order.status}</MobileBadge></div>
              <p>{order.customer_name}</p>
              <div className="mobile-row mobile-muted"><span>{order.delivery_type} · {order.payment_method} / {order.payment_status}</span><strong>{money(order.total)}</strong></div>
              <div className="mobile-row mobile-muted"><span>{new Date(order.created_at).toLocaleString()}</span><span>{order.items.length} lines</span></div>
            </MobileCard>
          </Link>)}</div>}
  </MobilePage>;
}

export function MobileOrderDetailPage() {
  const { id = "" } = useParams();
  const { money, lang } = useI18n();
  const navigate = useNavigate();
  const context = useOnlineOrders();
  const [order, setOrder] = useState<OnlineOrder | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [error, setError] = useState("");
  const repository = useMemo(() => getOnlineOrdersRepository(), []);

  const load = async () => {
    if (!can("orders.view") || !id) { setState("denied"); return; }
    setState("loading");
    try { setOrder(await repository.getOrder(id)); setState("ready"); }
    catch { setOrder(null); setState("denied"); }
  };
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action: OrderAction) => {
    if (!order) return;
    const reason = requiresReason(action) ? window.prompt("Reason is required")?.trim() : null;
    if (requiresReason(action) && !reason) return;
    setError("");
    try {
      await requireMobileOnline();
      const updated = await context.perform(order.id, action, reason);
      if (updated) setOrder(updated);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Action unavailable"); }
  };

  return <MobilePage title={order?.order_number ?? "Order detail"} subtitle="Branch-authorized detail" actions={<button className="mobile-action" type="button" onClick={() => navigate(-1)}>Back</button>}>
    {state === "loading" ? <MobileState kind="loading" title="Loading order…" /> : null}
    {state === "denied" ? <MobileState kind="denied" title="Access denied or order unavailable" detail="The order is not available in your active authorized branch." /> : null}
    {state === "error" ? <MobileState kind="error" title="Order unavailable" detail={error} /> : null}
    {order ? <>
      {error ? <MobileState kind="error" title="Action not completed" detail={error} /> : null}
      <MobileCard>
        <div className="mobile-row"><MobileBadge tone={tones[order.status]}>{order.status}</MobileBadge><strong>{money(order.total)}</strong></div>
        <dl className="mobile-detail-grid">
          <div><dt>Customer</dt><dd>{order.customer_name}</dd></div>
          <div><dt>Phone</dt><dd dir="ltr">{order.customer_phone}</dd></div>
          <div><dt>Fulfilment</dt><dd>{order.delivery_type} · {deliveryStatusOf(order)}</dd></div>
          <div><dt>Payment</dt><dd>{order.payment_method} · {order.payment_status}</dd></div>
          {order.address ? <div className="mobile-detail-wide"><dt>Address</dt><dd>{order.address.city} · {order.address.area} · {order.address.street}</dd></div> : null}
          {order.delivery_zone_name_en || order.delivery_zone_name_ar ? <div><dt>Zone</dt><dd>{lang === "ar" ? order.delivery_zone_name_ar : order.delivery_zone_name_en}</dd></div> : null}
          <div><dt>Discount</dt><dd>{money(order.discount_amount)}</dd></div>
        </dl>
      </MobileCard>
      <h2 className="mobile-section-title">Items</h2>
      <div className="mobile-list">{order.items.map((item) => <MobileCard key={item.id}>
        <strong>{lang === "ar" ? item.name_ar : item.name_en}</strong>
        <p>{[lang === "ar" ? item.variant_color_ar : item.variant_color_en, item.variant_size_label ?? item.variant_size].filter(Boolean).join(" / ") || "—"}</p>
        <div className="mobile-row mobile-muted"><span dir="ltr">{item.sku} · {item.barcode ?? "—"}</span><span>{item.quantity} × {money(item.unit_price)}</span></div>
      </MobileCard>)}</div>
      <h2 className="mobile-section-title">History</h2>
      <MobileCard>{order.events.length ? <ol className="mobile-timeline">{order.events.map((event) => <li key={event.id}><strong>{event.kind}</strong><span>{new Date(event.created_at).toLocaleString()} · {event.user_name ?? "Customer"}</span>{event.note ? <p>{event.note}</p> : null}</li>)}</ol> : <p>No events available.</p>}</MobileCard>
      {context.actionsFor(order).length ? <div className="mobile-sticky-actions">{context.actionsFor(order).map((action) => <button type="button" key={action} disabled={Boolean(context.busyAction)} className={action === "cancel" || action === "payment_reject" ? "danger" : ""} onClick={() => void act(action)}>{action.replace(/_/g, " ")}</button>)}</div> : null}
    </> : null}
  </MobilePage>;
}
