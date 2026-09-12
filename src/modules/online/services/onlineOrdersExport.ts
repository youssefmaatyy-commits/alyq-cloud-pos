/**
 * Online-orders export — the Online Orders screen's own file.
 *
 * Two sheets, the same pairing the invoice export uses: one row per order and
 * one row per ordered line. The line sheet is what makes the file useful for
 * anything beyond a total — "which products did the website sell this week" is
 * a question the order sheet cannot answer, because an order is a bundle.
 *
 * Money columns are written as numbers in EGP like every other export here, so
 * the shop's accountant can sum them in Excel rather than re-typing them. The
 * delivery fee is its own column and is *not* folded into the subtotal: an
 * approved order becomes a POS sale for the goods only, and a spreadsheet that
 * hid the fee would not reconcile with the till.
 */
import { buildSheets, toDate, type BuiltSheet, type ExportSheet, type PickBilingual, type Translate } from "@/lib/export";
import type { OnlineOrder, OnlineOrderItem } from "../types";

export interface OnlineOrdersExportInput {
  /** Already filtered by the screen. */
  orders: readonly OnlineOrder[];
  t: Translate;
  pick: PickBilingual;
}

const money = (value: number) => Math.round(value * 100) / 100;

interface OrderItemRow {
  order: OnlineOrder;
  item: OnlineOrderItem;
}

export function buildOnlineOrderSheets(input: OnlineOrdersExportInput): BuiltSheet[] {
  const { t, pick, orders } = input;

  const itemRows: OrderItemRow[] = orders.flatMap((order) =>
    order.items.map((item) => ({ order, item })),
  );

  const ordersSheet: ExportSheet<OnlineOrder> = {
    name: t("export.sheet.onlineOrders"),
    rows: orders,
    columns: [
      { header: t("export.col.orderNumber"), value: (r) => r.order_number, width: 16 },
      { header: t("export.col.dateTime"), value: (r) => toDate(r.created_at), kind: "datetime", width: 20 },
      { header: t("export.col.customer"), value: (r) => r.customer_name, width: 22 },
      { header: t("export.col.customerPhone"), value: (r) => r.customer_phone, width: 16 },
      { header: t("export.col.status"), value: (r) => t(`online.status.${r.status}`), width: 14 },
      { header: t("export.col.paymentMethod"), value: (r) => t(`online.paymentMethod.${r.payment_method}`), width: 16 },
      { header: t("export.col.paymentStatus"), value: (r) => t(`online.paymentStatus.${r.payment_status}`), width: 18 },
      { header: t("export.col.deliveryType"), value: (r) => t(`online.deliveryType.${r.delivery_type}`), width: 14 },
      { header: t("export.col.address"), value: (r) => addressLine(r, t("online.deliveryType.pickup")), width: 34 },
      { header: t("export.col.itemsCount"), value: (r) => r.items.reduce((sum, item) => sum + item.quantity, 0), kind: "number", width: 8 },
      { header: t("export.col.subtotal"), value: (r) => money(r.subtotal), kind: "money", width: 12 },
      { header: t("export.col.discountCode"), value: (r) => r.discount_code, width: 14 },
      { header: t("export.col.discount"), value: (r) => money(r.discount_amount), kind: "money", width: 12 },
      { header: t("export.col.deliveryFee"), value: (r) => money(r.delivery_fee), kind: "money", width: 12 },
      { header: t("export.col.total"), value: (r) => money(r.total), kind: "money", width: 12 },
      { header: t("export.col.saleNumber"), value: (r) => r.sale_number, width: 16 },
      { header: t("export.col.approvedBy"), value: (r) => r.approved_by_name, width: 18 },
      { header: t("export.col.approvedAt"), value: (r) => (r.approved_at ? toDate(r.approved_at) : null), kind: "datetime", width: 20 },
      { header: t("export.col.paymentReference"), value: (r) => r.payment_reference, width: 20 },
      { header: t("export.col.voidReason"), value: (r) => r.cancellation_reason, width: 26 },
      { header: t("export.col.notes"), value: (r) => r.notes, width: 26 },
    ],
    totals: [
      t("export.col.total"),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      orders.reduce((sum, order) => sum + order.items.reduce((inner, item) => inner + item.quantity, 0), 0),
      money(orders.reduce((sum, order) => sum + order.subtotal, 0)),
      "",
      money(orders.reduce((sum, order) => sum + order.discount_amount, 0)),
      money(orders.reduce((sum, order) => sum + order.delivery_fee, 0)),
      money(orders.reduce((sum, order) => sum + order.total, 0)),
    ],
    notes: [t("online.export.deliveryFeeNote")],
  };

  const itemsSheet: ExportSheet<OrderItemRow> = {
    name: t("export.sheet.onlineOrderItems"),
    rows: itemRows,
    columns: [
      { header: t("export.col.orderNumber"), value: (r) => r.order.order_number, width: 16 },
      { header: t("export.col.dateTime"), value: (r) => toDate(r.order.created_at), kind: "datetime", width: 20 },
      { header: t("export.col.product"), value: (r) => pick(r.item.name_ar, r.item.name_en), width: 30 },
      { header: t("export.col.sku"), value: (r) => r.item.sku, width: 16 },
      { header: t("export.col.barcode"), value: (r) => r.item.barcode, width: 16 },
      { header: t("export.col.unitPrice"), value: (r) => money(r.item.unit_price), kind: "money", width: 12 },
      { header: t("export.col.quantity"), value: (r) => r.item.quantity, kind: "number", width: 10 },
      { header: t("export.col.lineTotal"), value: (r) => money(r.item.line_total), kind: "money", width: 12 },
      { header: t("export.col.status"), value: (r) => t(`online.status.${r.order.status}`), width: 14 },
    ],
    totals: [
      t("export.col.total"),
      "",
      "",
      "",
      "",
      "",
      itemRows.reduce((sum, row) => sum + row.item.quantity, 0),
      money(itemRows.reduce((sum, row) => sum + row.item.line_total, 0)),
    ],
  };

  return buildSheets([ordersSheet as ExportSheet<unknown>, itemsSheet as ExportSheet<unknown>]);
}

/**
 * One line an office can read. A pickup order has no address to print, so the
 * cell says so rather than going blank — a blank would look like missing data.
 */
function addressLine(order: OnlineOrder, pickupLabel: string): string {
  if (order.delivery_type === "pickup") return pickupLabel;
  const address = order.address;
  if (!address) return "";
  return [address.street, address.area, address.city, address.building, address.floor, address.apartment]
    .filter((part) => Boolean(part && part.trim()))
    .join("، ");
}
