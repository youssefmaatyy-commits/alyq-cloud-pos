/**
 * The online-order detail dialog — where an employee actually works an order.
 *
 * Everything needed to make the two decisions this screen exists for is on it:
 * is this order real (customer, address, items, stock held), and has the money
 * arrived (InstaPay reference, the proof image, who verified what). Neither
 * decision is inferable from a list row, which is why the row opens this.
 *
 * Actions come from `availableActions`, never from a hand-written list per
 * status: the workflow module is the single place that knows an approved order
 * can be cancelled only by somebody who may void a sale. Buttons this user
 * cannot use are not rendered, so nothing here can fail on click.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, Button, Modal, TextArea, useToast } from "@/components/ui";
import type { OnlineOrder, OrderAction } from "../types";
import { useOnlineOrders } from "../hooks/OnlineOrdersProvider";
import { WhatsAppUpdatePanel, useWhatsAppUpdates } from "./WhatsAppUpdatePanel";
import { suggestedTemplateKey } from "../services/whatsapp";
import type { WhatsAppTemplateKey } from "../types";
import { operationalStageLabelKey, operationalStageOf } from "../services/orderOperations";
import { deliveryStatusOf } from "../services/orderWorkflow";
import { MobileBadge, MobileCard } from "@/modules/mobile/components/MobilePrimitives";
import "@/modules/mobile/mobile.css";

/** Which actions need a reason typed before they run. */
const REASON_ACTIONS: OrderAction[] = ["cancel", "payment_reject"];

/** Common shop reasons are a starting point, never a replacement for the note. */
const REASON_PRESET_KEYS = {
  cancel: [
    "online.orders.reasonPreset.cancel.customerRequest",
    "online.orders.reasonPreset.cancel.stock",
    "online.orders.reasonPreset.cancel.delivery",
    "online.orders.reasonPreset.cancel.duplicate",
  ],
  payment_reject: [
    "online.orders.reasonPreset.reject.reference",
    "online.orders.reasonPreset.reject.proof",
    "online.orders.reasonPreset.reject.amount",
    "online.orders.reasonPreset.reject.pending",
  ],
} as const;

const STATUS_TONE: Record<OnlineOrder["status"], "neutral" | "success" | "danger" | "info" | "warning"> = {
  pending: "warning",
  approved: "info",
  processing: "info",
  ready: "success",
  completed: "success",
  cancelled: "danger",
};

const PAYMENT_TONE: Record<OnlineOrder["payment_status"], "neutral" | "success" | "danger" | "info" | "warning"> = {
  pending: "neutral",
  paid: "success",
  failed: "danger",
  verification_required: "warning",
};

export function OrderDetailModal({ order, onClose }: { order: OnlineOrder | null; onClose: () => void }) {
  const { t, pick, num, date, money } = useI18n();
  const toast = useToast();
  const {
    perform,
    actionsFor,
    busyAction,
    actionError,
    clearActionError,
    saleFor,
    products,
    reservedByProduct,
    canVerifyPayment,
  } = useOnlineOrders();

  const [reasonFor, setReasonFor] = useState<OrderAction | null>(null);
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  const [offerKey, setOfferKey] = useState<WhatsAppTemplateKey | null>(null);
  const templates = useWhatsAppUpdates();

  useEffect(() => {
    if (!order) {
      setReasonFor(null);
      setReason("");
    }
  }, [order]);

  if (!order) return null;

  const actions = actionsFor(order);
  const actionLabel = (action: OrderAction) =>
    t(action === "cancel" && order.status === "pending" ? "online.action.reject" : `online.action.${action}`);
  const sale = saleFor(order);
  const busy = busyAction?.orderId === order.id ? busyAction.action : null;

  const run = async (action: OrderAction, withReason?: string) => {
    setRunning(true);
    clearActionError();
    const updated = await perform(order.id, action, withReason ?? null);
    setRunning(false);
    setReasonFor(null);
    setReason("");
    if (updated) {
      toast.success(
        action === "cancel" && order.status === "pending"
          ? t("online.orders.done.reject")
          : t(`online.orders.done.${action}`),
      );
      const suggested = suggestedTemplateKey(updated);
      if (suggested && action !== "cancel" && action !== "payment_approve" && action !== "payment_reject") {
        setOfferKey(suggested);
      }
      if (action === "approve" && updated.sale_number) {
        toast.push(t("online.orders.saleCreated", { number: updated.sale_number }), "info");
      }
      if (action === "cancel") {
        toast.push(t("online.orders.stockReleased"), "info");
      }
    } else if (actionError) {
      // The code's copy, never the server's wording: a raw Postgres refusal
      // (enum casts, SQLSTATEs) must not reach the operator's screen. The
      // technical detail stays on `actionError.message` for the dev log, and
      // the inline banner below renders the same code the same way.
      toast.error(t(`online.error.${actionError.code}`));
    }
  };

  const address = order.address
    ? [order.address.street, order.address.area, order.address.city, order.address.building, order.address.floor, order.address.apartment]
        .filter((part) => Boolean(part && part.trim()))
        .join("، ")
    : "";

  const label = "text-[11px] font-bold uppercase tracking-wide text-stone-500";

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-bold text-[#9a7a49]" dir="ltr">
              {order.order_number}
            </span>
            <Badge tone={STATUS_TONE[order.status]}>
              {t(operationalStageLabelKey(operationalStageOf(order)))}
            </Badge>
            <Badge tone={PAYMENT_TONE[order.payment_status]}>
              {t(`online.paymentStatus.${order.payment_status}`)}
            </Badge>
          </span>
        }
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t("common.close")}
            </Button>
            {actions.map((action) => {
              if (REASON_ACTIONS.includes(action)) {
                return (
                  <Button
                    key={action}
                    variant={action === "cancel" ? "danger" : "secondary"}
                    loading={busy === action}
                    disabled={running}
                    onClick={() => {
                      setReason("");
                      setReasonFor(action);
                    }}
                  >
                    {actionLabel(action)}
                  </Button>
                );
              }
              return (
                <Button
                  key={action}
                  variant={action === "approve" || action === "payment_approve" ? "primary" : "secondary"}
                  loading={busy === action}
                  disabled={running}
                  onClick={() => void run(action)}
                >
                  {t(`online.action.${action}`)}
                </Button>
              );
            })}
          </>
        }
      >
        <div className="space-y-5">
          {actionError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
              {t(`online.error.${actionError.code}`)}
              {actionError.detail.sku ? ` · ${String(actionError.detail.sku)}` : ""}
            </div>
          ) : null}

          {/* Mobile Management Reference Summary Card + Customer & Fulfilment */}
          <MobileCard>
            <div className="mobile-row mb-3">
              <MobileBadge tone={STATUS_TONE[order.status]}>
                {t(operationalStageLabelKey(operationalStageOf(order)))}
              </MobileBadge>
              <strong className="text-base text-[#172033]">{money(order.total)}</strong>
            </div>
            <dl className="mobile-detail-grid sm:grid-cols-3">
              <div>
                <dt>{t("online.orders.customer")}</dt>
                <dd className="font-semibold text-[#172033]">{order.customer_name}</dd>
              </div>
              <div>
                <dt>{t("export.col.phone")}</dt>
                <dd dir="ltr">
                  <a href={`tel:${order.customer_phone}`} className="font-semibold text-[#9a7a49] hover:underline">
                    {order.customer_phone}
                  </a>
                </dd>
              </div>
              <div>
                <dt>{t("online.orders.filterFulfilment")}</dt>
                <dd>
                  {t(`online.deliveryType.${order.delivery_type}`)} · {deliveryStatusOf(order)}
                </dd>
              </div>
              <div>
                <dt>{t("online.orders.payment")}</dt>
                <dd>
                  {t(`online.paymentMethod.${order.payment_method}`)} · {t(`online.paymentStatus.${order.payment_status}`)}
                </dd>
              </div>
              {order.delivery_zone_name_ar || order.delivery_zone_name_en ? (
                <div>
                  <dt>{t("online.zones.title")}</dt>
                  <dd>{pick(order.delivery_zone_name_ar ?? "", order.delivery_zone_name_en ?? "")}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t("export.col.discount")}</dt>
                <dd>{money(order.discount_amount)}</dd>
              </div>
              <div className="mobile-detail-wide">
                <dt>
                  {order.delivery_type === "pickup"
                    ? t("online.deliveryType.pickup")
                    : t("online.deliveryType.delivery")}
                </dt>
                <dd>{address || t("online.orders.noAddress")}</dd>
                {order.address?.notes ? <p className="mt-1 text-xs text-stone-600">{order.address.notes}</p> : null}
                {order.notes ? (
                  <p className="mt-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-xs font-semibold text-amber-900">
                    {t("online.orders.customerNote")}: {order.notes}
                  </p>
                ) : null}
              </div>
            </dl>
          </MobileCard>

          <WhatsAppUpdatePanel
            order={order}
            templates={templates}
            preferredKey={offerKey}
            offerNote={offerKey !== null}
            onDismissOffer={() => setOfferKey(null)}
          />

          {/* items */}
          <section>
            <p className={label}>{t("online.orders.items")}</p>
            <div className="mt-2 overflow-x-auto rounded-xl border border-stone-200">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-bold uppercase tracking-wider text-stone-600">
                    <th className="px-3 py-2 text-start font-semibold">{t("export.col.product")}</th>
                    <th className="px-3 py-2 text-start font-semibold">{t("export.col.sku")}</th>
                    <th className="px-3 py-2 text-end font-semibold">{t("export.col.quantity")}</th>
                    <th className="px-3 py-2 text-end font-semibold">{t("export.col.unitPrice")}</th>
                    <th className="px-3 py-2 text-end font-semibold">{t("export.col.lineTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item) => {
                    const product = products.find((candidate) => candidate.id === item.product_id);
                    const held = reservedByProduct.get(item.product_id) ?? 0;
                    return (
                      <tr key={item.id} className="border-b border-stone-50 last:border-0">
                        <td className="px-3 py-2">
                          <p className="font-semibold text-stone-900">{pick(item.name_ar, item.name_en)}</p>
                          {/* The frozen combination — what the customer actually
                              ordered, still readable after any rename. */}
                          {item.variant_id ? (
                            <p className="text-[11px] font-bold text-stone-700" data-testid="order-line-variant">
                              {pick(item.variant_color_ar, item.variant_color_en) || item.variant_display_name || ""}
                              {item.variant_size !== null
                                ? ` / ${Math.round(item.variant_size * 100) / 100}`
                                : item.variant_size_label
                                  ? ` / ${item.variant_size_label}`
                                  : ""}
                            </p>
                          ) : null}
                          {product ? (
                            <p className="text-[11px] text-stone-500">
                              {t("online.orders.stockNow", { count: num(product.stock_quantity, 0) })}
                              {held > 0 ? ` · ${t("online.orders.heldByPending", { count: num(held, 0) })}` : ""}
                            </p>
                          ) : (
                            <p className="text-[11px] font-semibold text-rose-600">
                              {t("online.orders.productGone")}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-stone-600" dir="ltr">
                          {item.sku}
                          {item.barcode ? <span className="block text-[10px] text-stone-400">{item.barcode}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-end font-bold tabular-nums">{num(item.quantity, 0)}</td>
                        <td className="px-3 py-2 text-end tabular-nums">{money(item.unit_price)}</td>
                        <td className="px-3 py-2 text-end font-bold tabular-nums">{money(item.line_total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* money + payment */}
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
              <p className={label}>{t("online.orders.money")}</p>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-stone-600">{t("export.col.subtotal")}</dt>
                  <dd className="font-semibold tabular-nums">{money(order.subtotal)}</dd>
                </div>
                {order.discount_amount > 0 ? (
                  <div className="flex justify-between gap-2 text-emerald-700">
                    <dt>
                      {t("export.col.discount")}
                      {order.discount_code ? ` · ${order.discount_code}` : ""}
                    </dt>
                    <dd className="font-semibold tabular-nums">−{money(order.discount_amount)}</dd>
                  </div>
                ) : null}
                {order.delivery_fee > 0 ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-stone-600">{t("export.col.deliveryFee")}</dt>
                    <dd className="font-semibold tabular-nums">{money(order.delivery_fee)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-2 border-t border-stone-200 pt-1 text-base">
                  <dt className="font-bold text-stone-900">{t("export.col.total")}</dt>
                  <dd className="font-black tabular-nums text-stone-900">{money(order.total)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] leading-relaxed text-stone-500">
                {t("online.orders.deliveryFeeNotInSale")}
              </p>
            </div>

            <div className="rounded-xl border border-stone-200 p-3">
              <p className={label}>{t("online.orders.payment")}</p>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-stone-600">{t("export.col.paymentMethod")}</dt>
                  <dd className="font-semibold">{t(`online.paymentMethod.${order.payment_method}`)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-stone-600">{t("export.col.paymentStatus")}</dt>
                  <dd>
                    <Badge tone={PAYMENT_TONE[order.payment_status]}>
                      {t(`online.paymentStatus.${order.payment_status}`)}
                    </Badge>
                  </dd>
                </div>
                {order.payment_reference ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-stone-600">{t("export.col.paymentReference")}</dt>
                    <dd className="font-mono text-xs font-semibold" dir="ltr">
                      {order.payment_reference}
                    </dd>
                  </div>
                ) : null}
                {order.payment_submitted_at ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-stone-600">{t("online.orders.proofSubmittedAt")}</dt>
                    <dd className="text-xs font-semibold">{date(order.payment_submitted_at)}</dd>
                  </div>
                ) : null}
                {order.payment_verified_by_name ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-stone-600">{t("online.orders.verifiedBy")}</dt>
                    <dd className="text-xs font-semibold">
                      {order.payment_verified_by_name}
                      {order.payment_verified_at ? ` · ${date(order.payment_verified_at)}` : ""}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {order.payment_proof_url ? (
                <a
                  href={order.payment_proof_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 block"
                >
                  <img
                    src={order.payment_proof_url}
                    alt={t("online.orders.proofImage")}
                    loading="lazy"
                    decoding="async"
                    className="h-32 w-full rounded-lg border border-stone-200 bg-white object-contain"
                  />
                  <span className="mt-1 block text-[11px] font-bold text-[#9a7a49] hover:underline">
                    {t("online.orders.openProof")}
                  </span>
                </a>
              ) : order.payment_method === "instapay" ? (
                <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] font-semibold text-amber-900">
                  {t("online.orders.noProofYet")}
                </p>
              ) : null}

              {order.payment_rejected_reason ? (
                <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] font-semibold text-rose-800">
                  {t("online.orders.rejectionReason")}: {order.payment_rejected_reason}
                </p>
              ) : null}

              {order.payment_status === "verification_required" && !canVerifyPayment ? (
                <p className="mt-2 text-[11px] font-semibold text-stone-500">
                  {t("online.orders.needsVerifier")}
                </p>
              ) : null}
            </div>
          </section>

          {/* provenance */}
          <section className="rounded-xl border border-stone-200 p-3">
            <p className={label}>{t("online.orders.provenance")}</p>
            <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              {order.approved_by_name ? (
                <p className="text-stone-700">
                  <span className="font-bold">{t("online.orders.approvedBy")}</span>{" "}
                  {order.approved_by_name}
                  {order.approved_at ? ` · ${date(order.approved_at)}` : ""}
                </p>
              ) : null}
              {order.cancelled_by_name ? (
                <p className="text-stone-700">
                  <span className="font-bold">{t("online.orders.cancelledBy")}</span>{" "}
                  {order.cancelled_by_name}
                  {order.cancelled_at ? ` · ${date(order.cancelled_at)}` : ""}
                </p>
              ) : null}
              {order.cancellation_reason ? (
                <p className="text-stone-700 sm:col-span-2">
                  <span className="font-bold">{t("export.col.voidReason")}</span>{" "}
                  {order.cancellation_reason}
                </p>
              ) : null}
              {sale ? (
                <p className="text-stone-700 sm:col-span-2">
                  <span className="font-bold">{t("export.col.saleNumber")}</span>{" "}
                  <Link to={`/pos/sales/${sale.id}`} className="font-mono text-[#9a7a49] hover:underline" dir="ltr">
                    {sale.sale_number}
                  </Link>
                  <span className="ms-2 text-stone-500">{t("online.orders.sourceOnline")}</span>
                </p>
              ) : null}
            </div>
          </section>

          {/* timeline */}
          <section>
            <p className={label}>{t("online.orders.timeline")}</p>
            <MobileCard className="mt-2">
              {order.events.length > 0 ? (
                <ol className="mobile-timeline">
                  {order.events
                    .slice()
                    .reverse()
                    .map((event) => (
                      <li key={event.id}>
                        <strong className="text-xs font-bold text-[#172033]">
                          {t(`online.event.${event.kind}`)}
                        </strong>
                        <span>
                          {date(event.created_at)} · {event.user_name ?? "Customer"}
                        </span>
                        {event.note ? <p className="mt-1 text-xs text-stone-700">{event.note}</p> : null}
                      </li>
                    ))}
                </ol>
              ) : (
                <p className="text-xs text-stone-500">No events available.</p>
              )}
            </MobileCard>
          </section>
        </div>
      </Modal>

      {/* reason prompt — cancellation and a rejected payment both need one */}
      <Modal
        open={reasonFor !== null}
        onClose={() => setReasonFor(null)}
        size="sm"
        title={reasonFor ? actionLabel(reasonFor) : ""}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReasonFor(null)} disabled={running}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={reasonFor === "cancel" ? "danger" : "primary"}
              loading={running}
              disabled={!reason.trim()}
              onClick={() => reasonFor && void run(reasonFor, reason.trim())}
            >
              {t("common.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-stone-600">
          {reasonFor === "cancel" ? t("online.orders.cancelPrompt") : t("online.orders.rejectPrompt")}
        </p>
        {reasonFor === "cancel" || reasonFor === "payment_reject" ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {REASON_PRESET_KEYS[reasonFor].map((key) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant="ghost"
                disabled={running}
                onClick={() => setReason(t(key))}
              >
                {t(key)}
              </Button>
            ))}
          </div>
        ) : null}
        <TextArea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="mt-3"
          rows={3}
          placeholder={t("online.orders.reasonPlaceholder")}
          aria-label={t("online.orders.reasonLabel")}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-stone-500">
          {reasonFor === "cancel" ? t("online.orders.cancelConsequence") : t("online.orders.rejectConsequence")}
        </p>
      </Modal>
    </>
  );
}
