import type { Customer } from "../types";

const SEED_TIME = "2026-01-15T10:00:00.000Z";

export const DEMO_CUSTOMERS: Customer[] = [
  {
    id: "cust-1",
    name: "أحمد الشريف",
    phone: "0501234567",
    address: "الرياض، حي السليمانية",
    notes: "عميل دائم لمقهى أليك، يفضل الحبوب الإثيوبية.",
    created_at: SEED_TIME,
    updated_at: SEED_TIME,
  },
  {
    id: "cust-2",
    name: "سارة المحمود",
    phone: "0559876543",
    address: "جدة، طريق الملك عبد العزيز",
    notes: "طلبات جملة للمخبوزات والمشروبات.",
    created_at: new Date(Date.parse(SEED_TIME) - 86400000 * 5).toISOString(),
    updated_at: new Date(Date.parse(SEED_TIME) - 86400000 * 5).toISOString(),
  },
  {
    id: "cust-3",
    name: "مقهى الأندلس",
    phone: "0541122334",
    address: "الدمام، الكورنيش",
    notes: "شركة تجارية — عقد صيانة سنوي ومكينة إسبريسو.",
    created_at: new Date(Date.parse(SEED_TIME) - 86400000 * 12).toISOString(),
    updated_at: new Date(Date.parse(SEED_TIME) - 86400000 * 12).toISOString(),
  },
];

export function buildDemoCustomers(): Customer[] {
  return DEMO_CUSTOMERS.map((c) => ({ ...c }));
}
