/**
 * Which import kinds a seat may commit (Phase 58).
 *
 * Opening the center is `import_data`. Each kind still needs the write the
 * commit already asserts — viewing a list is not an import permission, and
 * there is no parallel `run_*_import` capability.
 */
import type { Capability } from "@/lib/permissions/roles";
import type { ImportKind } from "../types";

const ORDER: readonly ImportKind[] = ["products", "variants", "customers", "categories", "stock"];

export function importKindAdmitted(kind: ImportKind, can: (capability: Capability) => boolean): boolean {
  if (!can("import_data")) return false;
  if (kind === "products") return can("add_product") || can("edit_product");
  if (kind === "variants" || kind === "categories") return can("add_product");
  if (kind === "customers") return can("add_customer") || can("edit_customer");
  return can("adjust_stock");
}

export function importKindsAdmitted(can: (capability: Capability) => boolean): ImportKind[] {
  return ORDER.filter((kind) => importKindAdmitted(kind, can));
}
