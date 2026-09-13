/**
 * Repository selection for the online storefront.
 *
 * The same rule the rest of the app uses: if Supabase is configured, talk to it;
 * otherwise run the whole shop out of localStorage. Callers ask for the
 * capability they need (`getOnlineOrdersRepository`, …) rather than for a mode,
 * so no screen has to know which one it is running against — and the singletons
 * mean one instance holds the authoritative in-memory state in demo mode.
 */
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { getDemoOnlineRepository } from "./demoRepository";
import { getSupabaseOnlineRepository } from "./supabaseRepository";
import { getLocalStoreAccounts } from "./localAccounts";
import type {
  OnlineMode,
  OnlineOrdersRepository,
  StoreAccountsRepository,
  WebsiteRepository,
} from "./repository";

export type { OnlineMode };

function liveMode(): boolean {
  return isSupabaseConfigured && Boolean(getSupabaseClient());
}

export function getOnlineMode(): OnlineMode {
  return liveMode() ? "supabase" : "demo";
}

export function getOnlineOrdersRepository(): OnlineOrdersRepository {
  return liveMode() ? getSupabaseOnlineRepository() : getDemoOnlineRepository();
}

export function getWebsiteRepository(): WebsiteRepository {
  return liveMode() ? getSupabaseOnlineRepository() : getDemoOnlineRepository();
}

export function getStoreAccountsRepository(): StoreAccountsRepository {
  // Accounts are local in both modes (see `localAccounts.ts`); the mode is only
  // reported so the UI can say where data lives.
  return getLocalStoreAccounts(getOnlineMode());
}

export { OnlineError, toOnlineError } from "./repository";
export type {
  CampaignDraft,
  CouponDraft,
  FaqDraft,
  OnlineOrderFilter,
  OrderCounts,
  PlaceOrderResult,
  ProductContentDraft,
  ReviewDraft,
  StoreCustomerPatch,
  WebsiteSnapshot,
} from "./repository";
export { normalizeAddresses, emptyAddress } from "./demoRepository";
