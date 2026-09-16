import type { Customer, CustomerPatch, NewCustomer } from "../types";
import { AppError, type CustomerRepository } from "./repository";
import { buildDemoCustomers } from "./demoSeed";
import { safeStorage } from "@/modules/products/data/demoSeed";

const STORAGE_KEY = "alyq.demo.customers.v1";
const LATENCY = 100;

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `cust-${rand}`;
}

function load(): Customer[] {
  const raw = safeStorage.get(STORAGE_KEY);
  if (!raw) return buildDemoCustomers();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : buildDemoCustomers();
  } catch {
    return buildDemoCustomers();
  }
}

function persist(list: Customer[]): void {
  safeStorage.set(STORAGE_KEY, JSON.stringify(list));
}

export class DemoCustomerRepository implements CustomerRepository {
  readonly kind = "demo" as const;
  private customers: Customer[];

  constructor() {
    this.customers = load();
  }

  async listCustomers(): Promise<Customer[]> {
    return delay([...this.customers].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }

  async getCustomer(id: string): Promise<Customer> {
    const found = this.customers.find((c) => c.id === id);
    if (!found) throw new AppError("NOT_FOUND", `Customer ${id} not found`);
    return delay(found);
  }

  async createCustomer(input: NewCustomer): Promise<Customer> {
    // Assert unique phone if provided
    const phone = input.phone.trim();
    if (phone) {
      const clash = this.customers.find((c) => c.phone.trim() === phone);
      if (clash) throw new AppError("VALIDATION", "Phone number already exists", "phone");
    }
    const customer: Customer = {
      ...input,
      id: newId(),
      name: input.name.trim(),
      phone,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.customers = [customer, ...this.customers];
    persist(this.customers);
    return delay(customer, 40);
  }

  async updateCustomer(id: string, patch: CustomerPatch): Promise<Customer> {
    const idx = this.customers.findIndex((c) => c.id === id);
    if (idx === -1) throw new AppError("NOT_FOUND", `Customer ${id} not found`);

    if (patch.phone !== undefined) {
      const phone = patch.phone.trim();
      if (phone) {
        const clash = this.customers.find((c) => c.id !== id && c.phone.trim() === phone);
        if (clash) throw new AppError("VALIDATION", "Phone number already exists", "phone");
      }
    }

    const current = this.customers[idx];
    const updated: Customer = {
      ...current,
      ...patch,
      name: patch.name !== undefined ? patch.name.trim() : current.name,
      phone: patch.phone !== undefined ? patch.phone.trim() : current.phone,
      email: patch.email !== undefined ? (patch.email?.trim() || null) : current.email,
      address: patch.address !== undefined ? (patch.address?.trim() || null) : current.address,
      notes: patch.notes !== undefined ? (patch.notes?.trim() || null) : current.notes,
      updated_at: nowIso(),
    };
    this.customers[idx] = updated;
    persist(this.customers);
    return delay(updated, 40);
  }

  async deleteCustomer(id: string): Promise<void> {
    this.customers = this.customers.filter((c) => c.id !== id);
    persist(this.customers);
    await delay(undefined, 30);
  }

  reset(): void {
    this.customers = buildDemoCustomers();
    persist(this.customers);
  }
}

let singleton: DemoCustomerRepository | null = null;
export function getDemoCustomerRepository(): DemoCustomerRepository {
  if (!singleton) singleton = new DemoCustomerRepository();
  return singleton;
}
