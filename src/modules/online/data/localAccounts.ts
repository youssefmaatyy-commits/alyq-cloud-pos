/**
 * Website accounts, kept in the browser profile.
 *
 * Why not Supabase Auth: the project has a single auth realm and the POS treats
 * any session from it as a staff session. Signing shoppers in there would hand
 * the back office a session with no profile and no role — an authentication
 * change this project explicitly protects against. So accounts live here: name,
 * phone, saved addresses, wishlist, and the order numbers that browser placed.
 *
 * What that costs, stated plainly: an account does not follow a shopper to
 * another device or browser. What it does not cost is truth — order history is
 * fetched through `lookup_online_order`, which the database gates on the order
 * number plus the phone number the order was placed with, so nothing displayed
 * here can be invented locally.
 *
 * Passwords are stored as a salted digest beside the account. That is enough for
 * the sign-in flow to behave correctly and is explicitly not a way to keep a
 * secret; a shop that needs real accounts needs a second auth realm.
 */
import { safeStorage } from "@/modules/products/data/demoSeed";
import type { StoreCustomer } from "../types";
import { prepareProofImage, uploadStoreImage } from "../services/imageUpload";
import { OnlineError, toOnlineError } from "./repository";
import type { OnlineMode, StoreAccountsRepository, StoreCustomerPatch } from "./repository";

const CUSTOMERS_KEY = "alyq.demo.store_customers.v1";
const SESSION_KEY = "alyq.demo.store_session.v1";

/** An order reference the account remembers, used to fetch real history. */
export interface PlacedOrderRef {
  order_number: string;
  phone: string;
  placed_at: string;
}

interface StoredCustomer extends StoreCustomer {
  password_digest: string;
  placed: PlacedOrderRef[];
}

function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function delay<T>(value: T, ms = 60): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Phone numbers compare on digits: "+20 100 123 4567" == "01001234567". */
export function normalizePhone(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("20") && digits.length > 10) return digits;
  if (digits.startsWith("0") && digits.length === 11) return `20${digits.slice(1)}`;
  return digits;
}

export function normalizeEmail(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** Demo-grade digest: one-way enough not to store the password in the clear. */
export function digestPassword(password: string): string {
  const salted = `alyq.store::${password}`;
  let hash = 5381;
  for (let i = 0; i < salted.length; i += 1) {
    hash = (hash * 33) ^ salted.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function readCustomers(): StoredCustomer[] {
  const raw = safeStorage.get(CUSTOMERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      const customer = entry as Partial<StoredCustomer>;
      return {
        ...(customer as StoreCustomer),
        password_digest: customer.password_digest ?? "",
        placed: Array.isArray(customer.placed) ? customer.placed : [],
      } as StoredCustomer;
    });
  } catch {
    return [];
  }
}

/**
 * Resize a customer's payment proof and store it.
 *
 * Standalone rather than only a method, because the storefront provider needs it
 * before anybody has signed in: a guest can pay by InstaPay and submit a
 * reference, and turning that away for want of an account would be a lost sale.
 */
export async function uploadProofImage(file: File): Promise<string> {
  try {
    const prepared = await prepareProofImage(file);
    return await uploadStoreImage(prepared, "proofs");
  } catch (error) {
    throw toOnlineError(error);
  }
}

export class LocalStoreAccounts implements StoreAccountsRepository {
  readonly kind: OnlineMode;

  private customers: StoredCustomer[] = readCustomers();
  private sessionId: string | null = safeStorage.get(SESSION_KEY) || null;

  constructor(kind: OnlineMode) {
    this.kind = kind;
  }

  private persist(): void {
    safeStorage.set(CUSTOMERS_KEY, JSON.stringify(this.customers));
  }

  private strip(customer: StoredCustomer): StoreCustomer {
    const { password_digest: _digest, placed: _placed, ...rest } = customer;
    void _digest;
    void _placed;
    return rest;
  }

  async register(input: {
    name: string;
    phone: string;
    email?: string | null;
    password: string;
  }): Promise<StoreCustomer> {
    const name = input.name.trim();
    const phone = input.phone.trim();
    const email = normalizeEmail(input.email);
    if (!name || !phone) {
      throw new OnlineError("missing_contact", "Name and phone are required", {
        field: name ? "phone" : "name",
      });
    }
    if (!input.password || input.password.length < 6) {
      throw new OnlineError(
        "invalid_credentials",
        "A password of 6 characters or more is required",
        { field: "password" },
      );
    }
    const digits = normalizePhone(phone);
    if (this.customers.some((customer) => normalizePhone(customer.phone) === digits)) {
      throw new OnlineError("identifier_taken", "That phone number already has an account", {
        field: "phone",
      });
    }
    if (email && this.customers.some((customer) => normalizeEmail(customer.email) === email)) {
      throw new OnlineError("identifier_taken", "That email already has an account", {
        field: "email",
      });
    }

    const at = nowIso();
    const stored: StoredCustomer = {
      id: newId("cus"),
      name,
      email: email || null,
      phone,
      addresses: [],
      wishlist: [],
      notes: null,
      created_at: at,
      last_login_at: at,
      password_digest: digestPassword(input.password),
      placed: [],
    };
    this.customers = [...this.customers, stored];
    this.persist();
    this.setSession(stored.id);
    return delay(this.strip(stored));
  }

  async login(input: { identifier: string; password: string }): Promise<StoreCustomer> {
    const identifier = input.identifier.trim();
    const digits = normalizePhone(identifier);
    const email = normalizeEmail(identifier);
    const customer = this.customers.find(
      (candidate) =>
        normalizePhone(candidate.phone) === digits || normalizeEmail(candidate.email) === email,
    );
    // One message for "no such account" and "wrong password": telling them apart
    // hands out the list of registered phone numbers.
    if (!customer || customer.password_digest !== digestPassword(input.password)) {
      throw new OnlineError("invalid_credentials", "Those details do not match an account", {
        field: "identifier",
      });
    }
    const updated: StoredCustomer = { ...customer, last_login_at: nowIso() };
    this.customers = this.customers.map((candidate) =>
      candidate.id === updated.id ? updated : candidate,
    );
    this.persist();
    this.setSession(updated.id);
    return delay(this.strip(updated));
  }

  async logout(): Promise<void> {
    this.setSession(null);
    await delay(null);
  }

  async current(): Promise<StoreCustomer | null> {
    if (!this.sessionId) return null;
    const customer = this.customers.find((candidate) => candidate.id === this.sessionId);
    return customer ? delay(this.strip(customer)) : null;
  }

  async update(id: string, patch: StoreCustomerPatch): Promise<StoreCustomer> {
    const existing = this.customers.find((customer) => customer.id === id);
    if (!existing) throw new OnlineError("not_signed_in", "Account not found");

    if (patch.phone) {
      const digits = normalizePhone(patch.phone);
      if (
        this.customers.some(
          (customer) => customer.id !== id && normalizePhone(customer.phone) === digits,
        )
      ) {
        throw new OnlineError("identifier_taken", "That phone number is already in use", {
          field: "phone",
        });
      }
    }
    const nextEmail =
      patch.email !== undefined ? normalizeEmail(patch.email) : normalizeEmail(existing.email);
    if (
      nextEmail &&
      this.customers.some(
        (customer) => customer.id !== id && normalizeEmail(customer.email) === nextEmail,
      )
    ) {
      throw new OnlineError("identifier_taken", "That email is already in use", { field: "email" });
    }

    const updated: StoredCustomer = {
      ...existing,
      name: patch.name?.trim() || existing.name,
      phone: patch.phone?.trim() || existing.phone,
      email: nextEmail || null,
      addresses: patch.addresses ?? existing.addresses,
      wishlist: patch.wishlist ?? existing.wishlist,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
    };
    this.customers = this.customers.map((customer) => (customer.id === id ? updated : customer));
    this.persist();
    return delay(this.strip(updated));
  }

  uploadProofImage(file: File): Promise<string> {
    return uploadProofImage(file);
  }

  async rememberOrder(
    customerId: string | null,
    orderNumber: string,
    phone: string,
  ): Promise<void> {
    if (!customerId || !orderNumber) return;
    const existing = this.customers.find((customer) => customer.id === customerId);
    if (!existing) return;
    const already = existing.placed.some((ref) => ref.order_number === orderNumber);
    if (already) return;
    const updated: StoredCustomer = {
      ...existing,
      placed: [
        ...existing.placed,
        { order_number: orderNumber, phone, placed_at: nowIso() },
      ],
    };
    this.customers = this.customers.map((customer) =>
      customer.id === customerId ? updated : customer,
    );
    this.persist();
    await delay(null);
  }

  /** The order references an account holds — newest first. */
  placedRefs(customerId: string | null): PlacedOrderRef[] {
    if (!customerId) return [];
    const customer = this.customers.find((candidate) => candidate.id === customerId);
    if (!customer) return [];
    return [...customer.placed].sort((a, b) => Date.parse(b.placed_at) - Date.parse(a.placed_at));
  }

  private setSession(id: string | null): void {
    this.sessionId = id;
    safeStorage.set(SESSION_KEY, id ?? "");
  }
}

let singleton: LocalStoreAccounts | null = null;

/** One account store per browser, shared by both repository modes. */
export function getLocalStoreAccounts(kind: OnlineMode): LocalStoreAccounts {
  if (!singleton) singleton = new LocalStoreAccounts(kind);
  return singleton;
}

export function resetLocalStoreAccounts(): void {
  singleton = null;
}
