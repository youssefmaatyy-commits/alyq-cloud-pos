/**
 * Emergency export — the whole business, one workbook, no database required.
 *
 * The scenario this exists for: the installation is damaged, or the account is
 * locked, or somebody simply needs every row on a disk they can hold. A backup
 * file answers "restore us"; this answers "give us the data", in the format the
 * shop's accountant already knows how to read.
 *
 * It is a composition, not an engine. Every sheet here is built by the same
 * builder the matching screen's export button uses — products, inventory,
 * customers, sales history, returns and refunds, expenses — so there is one
 * definition of what a products sheet contains, and it is not in this file. The
 * financial workbook deliberately stays on the Reports screen, where shift
 * summaries are live for an open shift and frozen once closed; reproducing that
 * here would mean producing a second, slightly different set of money figures,
 * which is the one thing a finance export must never do.
 *
 * Each section is loaded independently and a refusal skips that section rather
 * than the export: an admin whose role lacks `view_customers` still gets products,
 * stock, sales and expenses, and the result says which section was skipped and
 * why. In an emergency, a partial workbook in somebody's hands beats a complete
 * one blocked on a permission nobody is available to grant.
 */
import { downloadWorkbook, type BuiltSheet, type ExportResult, type PickBilingual, type Translate } from "@/lib/export";
import { assertSensitiveAction } from "@/lib/permissions/actions";
import { AppError } from "@/modules/products/data/repository";
import { loadCatalog } from "@/modules/products/services/catalogService";
import { categoryNameIndex } from "@/modules/products/services/categoryTree";
import { buildProductsSheets } from "@/modules/products/services/productsExport";
import { buildInventorySheets } from "@/modules/inventory/services/inventoryExport";
import { loadCustomers } from "@/modules/customers/services/customerService";
import { buildCustomersSheets } from "@/modules/customers/services/customersExport";
import { getSalesRepository } from "@/modules/pos/data";
import { buildSalesSheets } from "@/modules/pos/services/salesExport";
import { loadRefunds, loadReturns } from "@/modules/returns/services/returnService";
import { buildReturnsSheets } from "@/modules/returns/services/returnsExport";
import { loadExpenses } from "@/modules/expenses/services/expenseService";
import { buildExpensesSheets } from "@/modules/expenses/services/expensesExport";

export interface EmergencyExportInput {
  t: Translate;
  pick: PickBilingual;
  lang: "en" | "ar";
}

export interface EmergencyExportOutcome {
  result: ExportResult;
  /** Section keys that were refused or empty, so the UI can say what is missing. */
  skipped: string[];
}

/**
 * Build and download the workbook.
 *
 * Gated by `export_data` — the capability every other export in the app uses. A
 * new "emergency" capability would be a second door to the same rooms, and the
 * first thing to go missing during an incident is the permission nobody
 * remembers creating. What *is* separate is `export_backup`, which governs
 * downloading a restorable snapshot: that file contains the staff directory and
 * the audit trail, and no report does.
 */
/**
 * The emergency workbook needs `export_data` — the capability every other export
 * in the app uses, and an entry in the sensitive-action register like every other
 * gate. A new "emergency" capability would be a second door to the same rooms,
 * and the first thing to go missing during an incident is the permission nobody
 * remembers creating.
 */
export function assertCanRunEmergencyExport(): void {
  assertSensitiveAction("backup.emergency_export");
}

export async function exportEmergencyWorkbook(input: EmergencyExportInput): Promise<EmergencyExportOutcome> {
  assertCanRunEmergencyExport();
  const { t, pick, lang } = input;
  const skipped: string[] = [];
  const sheets: BuiltSheet[] = [];

  async function section(key: string, build: () => Promise<BuiltSheet[]>): Promise<void> {
    try {
      const built = await build();
      if (built.length === 0) {
        skipped.push(key);
        return;
      }
      sheets.push(...built);
    } catch (error) {
      // A refusal (or an empty module) costs one section, not the workbook.
      if (error instanceof AppError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")) {
        skipped.push(key);
        return;
      }
      skipped.push(key);
    }
  }

  const catalog = await loadCatalog().catch(() => null);

  await section("products", async () =>
    catalog
      ? buildProductsSheets({ products: catalog.products, categories: catalog.categories, t, pick })
      : [],
  );

  await section("inventory", async () => {
    if (!catalog) return [];
    const names = categoryNameIndex([...catalog.categories], pick);
    return buildInventorySheets({
      products: catalog.products,
      categoryName: (id) => (id ? (names.get(id) ?? "—") : "—"),
      t,
      pick,
    });
  });

  const sales = await getSalesRepository()
    .listSales()
    .catch(() => null);

  await section("customers", async () => {
    const customers = await loadCustomers();
    const returnsList = await loadReturns().catch(() => []);
    return buildCustomersSheets({ customers, sales: sales ?? [], returnsList, t });
  });

  await section("sales", async () => (sales ? buildSalesSheets({ sales, t, pick }) : []));

  await section("returns", async () => {
    const [returnsList, refundsList] = await Promise.all([loadReturns(), loadRefunds()]);
    if (returnsList.length === 0 && refundsList.length === 0) return [];
    return buildReturnsSheets({ returnsList, refundsList, t, pick });
  });

  await section("expenses", async () => {
    const expenses = await loadExpenses();
    return expenses.length === 0 ? [] : buildExpensesSheets({ expenses, t });
  });

  if (sheets.length === 0) {
    throw new AppError("FORBIDDEN", "backup.error.emergency_empty");
  }

  const result = await downloadWorkbook({ name: "alyq-emergency-data", sheets, lang });
  return { result, skipped };
}
