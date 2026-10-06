/**
 * Universal Data Export Center Page.
 *
 * Dedicated staff export hub for generating full-database Excel workbooks
 * across all business domains with date/branch/staff filters, formula sanitization,
 * and multi-sheet full business exports.
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  BoxIcon,
  Card,
  EmptyState,
  ExportButton,
  HistoryIcon,
  LayersIcon,
  ReceiptIcon,
  ReportIcon,
  SectionTitle,
  UsersIcon,
  WalletIcon,
  WarehouseIcon,
} from "@/components/ui";
import { canAct } from "@/lib/permissions/enforce";
import { useCatalog } from "@/modules/products";
import { useInventory } from "@/modules/inventory";
import { usePos } from "@/modules/pos";
import { useCustomers } from "@/modules/customers";
import { useReturns } from "@/modules/returns";
import { useExpenses } from "@/modules/expenses";
import { useShifts } from "@/modules/shifts";
import { useBranch, type BranchAccess } from "@/lib/branch";
import { getOnlineOrdersRepository } from "@/modules/online/data";
import { getSettingsRepository } from "@/modules/settings/data";
import { getAuditRepository } from "@/modules/audit/data";
import type { OnlineOrder } from "@/modules/online/types";
import type { ManagedUser } from "@/modules/settings/types";
import type { CustomRole } from "@/lib/permissions/customRoles";
import type { AuditLogEntry } from "@/modules/audit/types";
import {
  DateRangePicker,
  EMPTY_DATE_RANGE,
  toExportRange,
  type DateRangeValue,
  type RangePreset,
} from "../components/DateRangePicker";
import {
  buildFullBusinessExportWorkbook,
  buildUniversalAdminSheets,
  buildUniversalAuditSheets,
  buildUniversalCatalogSheets,
  buildUniversalCustomersSheets,
  buildUniversalInventorySheets,
  buildUniversalOnlineOrdersSheets,
  buildUniversalSalesSheets,
  buildUniversalShiftsSheets,
  type UniversalExportContext,
} from "../services/universalExport";

export function DataExportCenterPage() {
  const { t, pick } = useI18n();
  const allowed = canAct("export_data") || canAct("export_reports") || canAct("view_reports");
  const maySeeCost = canAct("view_cost");

  const catalog = useCatalog();
  const inventory = useInventory();
  const pos = usePos();
  const customerCtx = useCustomers();
  const returnsCtx = useReturns();
  const expenseCtx = useExpenses();
  const shiftCtx = useShifts();
  const { branches } = useBranch();

  // Filters
  const [range, setRange] = useState<DateRangeValue>(EMPTY_DATE_RANGE);
  const [preset, setPreset] = useState<RangePreset | null>("thisMonth");
  const [selectedBranch, setSelectedBranch] = useState<string>("all");
  const [selectedStaff, setSelectedStaff] = useState<string>("all");

  // Async datasets
  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [profiles, setProfiles] = useState<ManagedUser[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [, setLoadingAsync] = useState(false);

  const exportRange = useMemo(() => toExportRange(range), [range]);

  useEffect(() => {
    let cancelled = false;
    setLoadingAsync(true);
    void (async () => {
      try {
        const [ordersList, usersList, rolesList, auditList] = await Promise.all([
          getOnlineOrdersRepository().listOrders({}).catch(() => []),
          getSettingsRepository().listUsers().catch(() => []),
          getSettingsRepository().listCustomRoles().catch(() => []),
          canAct("view_audit_log")
            ? getAuditRepository().listEntries().catch(() => [])
            : Promise.resolve([]),
        ]);

        if (!cancelled) {
          setOrders(ordersList);
          setProfiles(usersList);
          setCustomRoles(rolesList);
          setAuditLogs(auditList);
        }
      } finally {
        if (!cancelled) setLoadingAsync(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const exportContext: UniversalExportContext = useMemo(
    () => ({
      t,
      pick,
      filter: {
        from: exportRange.from,
        to: exportRange.to,
        branchId: selectedBranch === "all" ? null : selectedBranch,
        staffId: selectedStaff === "all" ? null : selectedStaff,
      },
      maySeeCost,
    }),
    [t, pick, exportRange, selectedBranch, selectedStaff, maySeeCost],
  );

  if (!allowed) {
    return (
      <div>
        <PageHeader
          title="Universal Data Export Center / مركز تصدير البيانات"
          subtitle="Export all store records across financial, inventory, catalog and operational datasets"
        />
        <Card>
          <EmptyState
            icon="🔒"
            title={t("perm.denied")}
            description="You do not have permission to access data export."
          />
        </Card>
      </div>
    );
  }

  const fullBusinessData = {
    sales: pos.sales,
    products: catalog.products,
    variants: catalog.variants,
    categories: catalog.categories,
    customers: customerCtx.customers,
    returnsList: returnsCtx.returnsList,
    refundsList: returnsCtx.refundsList,
    expenses: expenseCtx.expenses,
    shifts: shiftCtx.shifts,
    shiftSummaryFor: shiftCtx.summaryFor,
    movements: inventory.movements,
    onlineOrders: orders,
    auditLogs,
    profiles,
    branches: branches as BranchAccess[],
    customRoles,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Universal Data Export Center / مركز تصدير البيانات الشامل"
        subtitle="Export complete database records to Excel with numeric formatting, date safety, and full reconciliation"
        crumbs={[
          { label: t("nav.dashboard"), to: "/" },
          { label: t("nav.reports"), to: "/reports" },
          { label: "Data Export Center / مركز التصدير" },
        ]}
      />

      {/* Global Filter Toolbar */}
      <Card className="p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 pb-3">
          <SectionTitle>Export Scope & Filters / نطاق التصدير والفلاتر</SectionTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-stone-500">Preset:</span>
            <span className="text-xs font-bold text-stone-800">{preset || "Custom"}</span>
          </div>
        </div>

        <DateRangePicker
          value={range}
          onChange={setRange}
          activePreset={preset}
          onPreset={setPreset}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">
              Branch Filter / تصفية الفرع
            </label>
            <select
              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-800"
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
            >
              <option value="all">🏢 All Branches (جميع الفروع)</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {pick(b.name_ar, b.name_en)} {b.code ? `(${b.code})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">
              Staff Filter / تصفية الموظف
            </label>
            <select
              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-800"
              value={selectedStaff}
              onChange={(e) => setSelectedStaff(e.target.value)}
            >
              <option value="all">👤 All Staff (جميع الموظفين)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.username} ({p.role})
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {/* Primary Action Banner: Full Business Export */}
      <Card className="bg-gradient-to-r from-stone-900 via-stone-800 to-stone-900 text-white p-6 rounded-2xl shadow-sm">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-2xl">📑</span>
              <h3 className="text-lg font-bold text-white">
                Full Business Export / تصدير شامل لبيانات النشاط
              </h3>
            </div>
            <p className="text-xs text-stone-300 max-w-2xl leading-relaxed">
              Generates a single multi-sheet Excel workbook (.xlsx) containing all 8 operational
              domains for business analysis, reporting, and external reconciliation. (Human-readable
              spreadsheet export — not a database restore point).
            </p>
          </div>
          <ExportButton
            name="full-business-export"
            authority="data"
            variant="primary"
            className="bg-white text-stone-900 hover:bg-stone-100 font-bold px-6 py-3 text-sm shadow-md"
            count={
              pos.sales.length +
              catalog.products.length +
              customerCtx.customers.length +
              inventory.movements.length
            }
            build={() => buildFullBusinessExportWorkbook(fullBusinessData, exportContext)}
          />
        </div>
      </Card>

      {/* 8 Domain Export Grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Domain 1: Sales & Money */}
        <DomainExportCard
          icon={<ReceiptIcon className="h-6 w-6 text-emerald-600" />}
          title="1. Sales & Money / المبيعات والمعاملات المالية"
          description="Invoices, itemized sale lines, split payments & tenders, customer credit, and sales returns / refunds."
          badge={`${pos.sales.length} Invoices`}
        >
          <ExportButton
            name="sales-and-money"
            authority="data"
            size="sm"
            count={pos.sales.length}
            build={() =>
              buildUniversalSalesSheets(
                pos.sales,
                returnsCtx.returnsList,
                returnsCtx.refundsList,
                exportContext,
              )
            }
          />
        </DomainExportCard>

        {/* Domain 2: Inventory */}
        <DomainExportCard
          icon={<WarehouseIcon className="h-6 w-6 text-amber-600" />}
          title="2. Inventory & Stock Ledger / المخزون وحركة الأصناف"
          description="Branch stock balances, complete stock movements audit ledger, valuations at cost & retail."
          badge={`${catalog.products.filter((p) => p.stock_tracking_enabled).length} Products`}
        >
          <ExportButton
            name="inventory-and-stock"
            authority="data"
            size="sm"
            count={inventory.movements.length}
            build={() =>
              buildUniversalInventorySheets(
                catalog.products,
                catalog.variants,
                inventory.movements,
                catalog.categories,
                exportContext,
              )
            }
          />
        </DomainExportCard>

        {/* Domain 3: Catalog */}
        <DomainExportCard
          icon={<BoxIcon className="h-6 w-6 text-indigo-600" />}
          title="3. Catalog & Variants / دليل المنتجات والمتغيرات"
          description="Complete product specifications, Color × Size combinations, barcode registries, categories and pricing."
          badge={`${catalog.products.length} Products · ${catalog.variants.length} Variants`}
        >
          <ExportButton
            name="catalog-master"
            authority="data"
            size="sm"
            count={catalog.products.length + catalog.variants.length}
            build={() =>
              buildUniversalCatalogSheets(
                catalog.products,
                catalog.variants,
                catalog.categories,
                exportContext,
              )
            }
          />
        </DomainExportCard>

        {/* Domain 4: Customers */}
        <DomainExportCard
          icon={<UsersIcon className="h-6 w-6 text-blue-600" />}
          title="4. Customers & CRM / دليل العملاء وسجل المشتريات"
          description="Customer directory with contact info, total orders count, lifetime spend, and account balances."
          badge={`${customerCtx.customers.length} Customers`}
        >
          <ExportButton
            name="customers-crm"
            authority="data"
            size="sm"
            count={customerCtx.customers.length}
            build={() =>
              buildUniversalCustomersSheets(
                customerCtx.customers,
                pos.sales,
                exportContext,
              )
            }
          />
        </DomainExportCard>

        {/* Domain 5: Online Orders */}
        <DomainExportCard
          icon={<LayersIcon className="h-6 w-6 text-purple-600" />}
          title="5. Online Orders / طلبات المتجر الإلكتروني"
          description="Web orders queue, customer delivery addresses, delivery zone fees, and stock reservations."
          badge={`${orders.length} Web Orders`}
        >
          <ExportButton
            name="online-orders"
            authority="data"
            size="sm"
            count={orders.length}
            build={() => buildUniversalOnlineOrdersSheets(orders, exportContext)}
          />
        </DomainExportCard>

        {/* Domain 6: Shifts & Cash */}
        <DomainExportCard
          icon={<WalletIcon className="h-6 w-6 text-teal-600" />}
          title="6. Shifts & Drawer Cash / ورديات الكاشير والمصروفات"
          description="Shift opening/closing drawer reconciliations, over/short balances, cash movements and expense records."
          badge={`${shiftCtx.shifts.length} Shifts · ${expenseCtx.expenses.length} Expenses`}
        >
          <ExportButton
            name="shifts-and-expenses"
            authority="data"
            size="sm"
            count={shiftCtx.shifts.length}
            build={() =>
              buildUniversalShiftsSheets(
                shiftCtx.shifts,
                expenseCtx.expenses,
                exportContext,
              )
            }
          />
        </DomainExportCard>

        {/* Domain 7: Operations & Audit */}
        <DomainExportCard
          icon={<HistoryIcon className="h-6 w-6 text-stone-600" />}
          title="7. Operations & Audit Trail / سجل التدقيق والأمان"
          description="Tamper-evident audit log events, user actions, entity modifications, and system security events."
          badge={`${auditLogs.length} Events`}
        >
          <ExportButton
            name="audit-trail"
            authority="data"
            size="sm"
            count={auditLogs.length}
            build={() => buildUniversalAuditSheets(auditLogs, exportContext)}
          />
        </DomainExportCard>

        {/* Domain 8: Admin & Setup */}
        <DomainExportCard
          icon={<ReportIcon className="h-6 w-6 text-stone-700" />}
          title="8. Admin & Permissions / إعدادات الفروع والمستخدمين"
          description="Staff user profiles, branch directory, active registers, custom roles matrix, and granted capabilities."
          badge={`${profiles.length} Users · ${branches.length} Branches`}
        >
          <ExportButton
            name="admin-setup"
            authority="data"
            size="sm"
            count={profiles.length + branches.length}
            build={() =>
              buildUniversalAdminSheets(profiles, branches as BranchAccess[], customRoles, exportContext)
            }
          />
        </DomainExportCard>
      </div>
    </div>
  );
}

function DomainExportCard({
  icon,
  title,
  description,
  badge,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col justify-between p-5 space-y-4 hover:shadow-md transition-shadow">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-stone-100">
              {icon}
            </div>
            <div>
              <h4 className="text-sm font-bold text-stone-900">{title}</h4>
              {badge && (
                <span className="mt-0.5 inline-block text-[10px] font-bold text-stone-500">
                  {badge}
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="text-xs text-stone-600 leading-relaxed">{description}</p>
      </div>
      <div className="flex items-center justify-end border-t border-stone-100 pt-3">
        {children}
      </div>
    </Card>
  );
}
