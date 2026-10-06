import type { CheckoutCopySettings } from "../types";

export type StorefrontLanguage = "ar" | "en";
export type CheckoutCopyBase =
  | "free_delivery_progress"
  | "estimated_total_advisory"
  | "delivery_calculated_helper";

/**
 * Read only the active language. Unlike the general `pick` helper, checkout
 * copy deliberately does not fall back to the other language: clearing Arabic
 * hides the line in Arabic without changing English, and vice versa.
 */
export function activeCheckoutCopy(
  copy: CheckoutCopySettings,
  base: CheckoutCopyBase,
  language: StorefrontLanguage,
): string {
  return copy[`${base}_${language}`].trim();
}

/**
 * Checkout copy is rendered by React as plain text. The only template token we
 * interpret is the amount already formatted by the storefront's money helper;
 * every other brace sequence and every HTML-looking character stays literal.
 */
export function checkoutCopyWithAmount(template: string, amount: string): string {
  return template.split("{{amount}}").join(amount);
}
