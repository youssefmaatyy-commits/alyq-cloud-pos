/**
 * WhatsApp order updates (Phase 55) — deep links only.
 *
 * There is no WhatsApp Business API in this installation. Opening a `wa.me`
 * link does not deliver a message, does not record delivery, and does not
 * change the order. The audit word, when one is written, is `initiated`.
 *
 * Templates are staff copy with a fixed placeholder set. Anything else in
 * `{{…}}` is stripped, so a template cannot leak cost, profit, approval ids
 * or payment secrets — those values are never even supplied.
 */
import { whatsAppDestination } from "@/lib/phone";
import type {
  DeliveryType,
  OnlineOrder,
  OnlineOrderStatus,
  WhatsAppMessageTemplate,
  WhatsAppTemplateKey,
  WhatsAppUpdatesSettings,
} from "../types";
import { WHATSAPP_PLACEHOLDERS, WHATSAPP_TEMPLATE_KEYS, type WhatsAppPlaceholder } from "../types";
export { WHATSAPP_PLACEHOLDERS, WHATSAPP_TEMPLATE_KEYS, type WhatsAppPlaceholder };

export const WHATSAPP_UPDATE_OUTCOME = "initiated" as const;

/** Opening the link does not move the order. Status stays on the existing workflow. */
export const WHATSAPP_UPDATE_MUTES_ORDER = false as const;

export const WHATSAPP_TEMPLATE_MAX = 600;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export function isWhatsAppTemplateKey(value: string): value is WhatsAppTemplateKey {
  return (WHATSAPP_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/**
 * The template that matches the order's actual status. Pickup and delivery do
 * not share a sentence — "out for delivery" is only `ready` + delivery.
 * Pending and cancelled have no customer status message here; we do not invent
 * a database status to cover them.
 */
export function suggestedTemplateKey(order: {
  status: OnlineOrderStatus;
  delivery_type: DeliveryType;
}): WhatsAppTemplateKey | null {
  if (order.status === "approved") return "approved";
  if (order.status === "processing") return "processing";
  if (order.status === "ready") return order.delivery_type === "pickup" ? "ready_pickup" : "ready_delivery";
  if (order.status === "completed") return order.delivery_type === "pickup" ? "completed_pickup" : "completed_delivery";
  return null;
}

/**
 * Governorate from the order snapshot: the zone name frozen at placement, else
 * the city the customer typed. Live zone settings are not consulted — an old
 * order must not pick up a renamed fee or a new estimate.
 */
export function orderGovernorateLabel(
  order: Pick<OnlineOrder, "delivery_zone_name_ar" | "delivery_zone_name_en" | "address">,
  language: "ar" | "en",
): string {
  const zone =
    language === "ar"
      ? order.delivery_zone_name_ar || order.delivery_zone_name_en
      : order.delivery_zone_name_en || order.delivery_zone_name_ar;
  if (zone && zone.trim()) return zone.trim();
  return (order.address?.city ?? "").trim();
}

/**
 * Customer tracking URL (Phase 51). Hash route on the storefront, never an
 * admin path. The phone is the one stored on the order — tracking matches it.
 */
export function customerTrackingLink(origin: string, orderNumber: string, phone: string): string {
  const base = origin.replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("order", orderNumber);
  params.set("phone", phone);
  return `${base}/#/store/track?${params.toString()}`;
}

export function trackingOriginFromLocation(location: { origin: string; pathname: string }): string {
  const path = location.pathname && location.pathname !== "/" ? location.pathname.replace(/\/$/, "") : "";
  return `${location.origin}${path}`;
}

export interface WhatsAppPlaceholderInput {
  customerName: string;
  orderNumber: string;
  orderTotalLabel: string;
  governorate: string;
  trackingLink: string;
  paymentMethodLabel: string;
  deliveryMethodLabel: string;
}

/** Only the allow-listed placeholders. Callers must not pass internal fields. */
export function whatsAppPlaceholderValues(input: WhatsAppPlaceholderInput): Record<WhatsAppPlaceholder, string> {
  return {
    customer_name: input.customerName.trim(),
    order_number: input.orderNumber.trim(),
    order_total: input.orderTotalLabel.trim(),
    delivery_governorate: input.governorate.trim(),
    tracking_link: input.trackingLink.trim(),
    payment_method: input.paymentMethodLabel.trim(),
    delivery_method: input.deliveryMethodLabel.trim(),
  };
}

/** Fill a template. Unknown `{{tokens}}` become empty — they are not looked up. */
export function fillWhatsAppTemplate(
  template: string,
  values: Partial<Record<WhatsAppPlaceholder, string>>,
): string {
  const filled = template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!(WHATSAPP_PLACEHOLDERS as readonly string[]).includes(key)) return "";
    return values[key as WhatsAppPlaceholder] ?? "";
  });
  return filled.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,،])/g, "$1").trim();
}

export function templateText(
  settings: WhatsAppUpdatesSettings,
  key: WhatsAppTemplateKey,
  language: "ar" | "en",
): string {
  const row = settings.templates[key];
  const text = language === "ar" ? row?.ar : row?.en;
  return typeof text === "string" ? text : "";
}

export type WhatsAppUpdatePlan =
  | {
      ok: true;
      url: string;
      destination: string;
      message: string;
      templateKey: WhatsAppTemplateKey;
      language: "ar" | "en";
      outcome: typeof WHATSAPP_UPDATE_OUTCOME;
      mutatesOrderStatus: typeof WHATSAPP_UPDATE_MUTES_ORDER;
    }
  | {
      ok: false;
      reason: "invalid_phone";
      outcome: typeof WHATSAPP_UPDATE_OUTCOME;
      mutatesOrderStatus: typeof WHATSAPP_UPDATE_MUTES_ORDER;
    };

/**
 * Build the deep link. Does not open it, does not write, does not claim delivery.
 * The stored phone is only read.
 */
export function planWhatsAppUpdate(input: {
  phone: string;
  template: string;
  values: Partial<Record<WhatsAppPlaceholder, string>>;
  templateKey: WhatsAppTemplateKey;
  language: "ar" | "en";
}): WhatsAppUpdatePlan {
  const destination = whatsAppDestination(input.phone);
  if (!destination) {
    return {
      ok: false,
      reason: "invalid_phone",
      outcome: WHATSAPP_UPDATE_OUTCOME,
      mutatesOrderStatus: WHATSAPP_UPDATE_MUTES_ORDER,
    };
  }
  const message = fillWhatsAppTemplate(input.template, input.values);
  const url = `https://wa.me/${destination}?text=${encodeURIComponent(message)}`;
  return {
    ok: true,
    url,
    destination,
    message,
    templateKey: input.templateKey,
    language: input.language,
    outcome: WHATSAPP_UPDATE_OUTCOME,
    mutatesOrderStatus: WHATSAPP_UPDATE_MUTES_ORDER,
  };
}

export function clampWhatsAppTemplate(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch.codePointAt(0) !== 0) out += ch;
  }
  return out.slice(0, WHATSAPP_TEMPLATE_MAX);
}

/**
 * Shipped sentences. Reset restores these. They name the real status and only
 * the allow-listed placeholders — no estimate, no internal id.
 */
export function defaultWhatsAppTemplates(): Record<WhatsAppTemplateKey, WhatsAppMessageTemplate> {
  return {
    approved: {
      ar: "تم تأكيد طلبك رقم {{order_number}} يا {{customer_name}}. الإجمالي {{order_total}}. {{delivery_method}} — {{delivery_governorate}}. الدفع: {{payment_method}}. تتبّع طلبك: {{tracking_link}}",
      en: "Your order {{order_number}} is confirmed, {{customer_name}}. Total {{order_total}}. {{delivery_method}} — {{delivery_governorate}}. Payment: {{payment_method}}. Track it: {{tracking_link}}",
    },
    processing: {
      ar: "طلبك رقم {{order_number}} قيد التجهيز يا {{customer_name}}. الإجمالي {{order_total}}. {{tracking_link}}",
      en: "Your order {{order_number}} is being prepared, {{customer_name}}. Total {{order_total}}. {{tracking_link}}",
    },
    ready_delivery: {
      ar: "طلبك رقم {{order_number}} خرج للتوصيل يا {{customer_name}} إلى {{delivery_governorate}}. الإجمالي {{order_total}}. {{tracking_link}}",
      en: "Your order {{order_number}} is out for delivery, {{customer_name}}, to {{delivery_governorate}}. Total {{order_total}}. {{tracking_link}}",
    },
    ready_pickup: {
      ar: "طلبك رقم {{order_number}} جاهز للاستلام يا {{customer_name}}. الإجمالي {{order_total}}. {{tracking_link}}",
      en: "Your order {{order_number}} is ready for pickup, {{customer_name}}. Total {{order_total}}. {{tracking_link}}",
    },
    completed_delivery: {
      ar: "تم تسليم طلبك رقم {{order_number}} يا {{customer_name}}. شكرًا لتسوقك معنا. {{tracking_link}}",
      en: "Your order {{order_number}} has been delivered, {{customer_name}}. Thank you for shopping with us. {{tracking_link}}",
    },
    completed_pickup: {
      ar: "تم استلام طلبك رقم {{order_number}} يا {{customer_name}}. شكرًا لتسوقك معنا. {{tracking_link}}",
      en: "Your order {{order_number}} has been collected, {{customer_name}}. Thank you for shopping with us. {{tracking_link}}",
    },
  };
}

export function defaultWhatsAppUpdates(): WhatsAppUpdatesSettings {
  return { templates: defaultWhatsAppTemplates() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep a staff edit, fill any missing status from the shipped sentence, and
 * drop unknown keys. A blank language falls back to the default so a cleared
 * box is a reset, not a silent empty message.
 */
export function resolveWhatsAppUpdates(stored: unknown): WhatsAppUpdatesSettings {
  const defaults = defaultWhatsAppUpdates();
  const root = isRecord(stored) ? stored : null;
  const bag = root && isRecord(root.templates) ? root.templates : null;
  if (!bag) return defaults;

  const templates = { ...defaults.templates };
  for (const key of WHATSAPP_TEMPLATE_KEYS) {
    const row = bag[key];
    if (!isRecord(row)) continue;
    const ar = typeof row.ar === "string" && row.ar.trim() ? clampWhatsAppTemplate(row.ar) : defaults.templates[key].ar;
    const en = typeof row.en === "string" && row.en.trim() ? clampWhatsAppTemplate(row.en) : defaults.templates[key].en;
    templates[key] = { ar, en };
  }
  return { templates };
}
