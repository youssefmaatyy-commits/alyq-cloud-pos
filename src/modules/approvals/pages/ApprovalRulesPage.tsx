import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  Field,
  LoadingBlock,
  SectionTitle,
  TextInput,
  useToast,
} from "@/components/ui";
import { AppError } from "@/modules/products/data/repository";
import { canAct } from "@/lib/permissions/enforce";
import { useApprovals } from "../hooks/ApprovalProvider";
import { approvalRulesToForm, type ApprovalRulesFormValues } from "../types";
import { validateApprovalRulesForm } from "../validation";

/**
 * Settings → Approval Rules (Phase 12, requirement 2).
 *
 * Four thresholds and one switch. The page validates locally so a typo is caught
 * before a round trip, and saves through the service, which asserts
 * `manage_settings` — the same capability that owns every other system-wide
 * setting — and audits the before and after. Raising a limit is how an
 * over-limit act becomes an ordinary one, so the trail matters here more than
 * anywhere else in the phase.
 *
 * A user without the capability sees the current rules and an explanation rather
 * than a form that would fail: the thresholds are shop policy, and knowing them
 * is what lets a cashier work inside them.
 */
export function ApprovalRulesPage() {
  const { t, date } = useI18n();
  const toast = useToast();
  const { rules, saveRules, loading, refresh } = useApprovals();

  const mayEdit = useMemo(() => canAct("manage_settings"), [rules]);
  const [form, setForm] = useState<ApprovalRulesFormValues>(() => approvalRulesToForm(rules));
  const [errors, setErrors] = useState<Partial<Record<keyof ApprovalRulesFormValues, string>>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm(approvalRulesToForm(rules));
  }, [rules]);

  const patch = (next: Partial<ApprovalRulesFormValues>) =>
    setForm((prev) => ({ ...prev, ...next }));

  const dirty = useMemo(() => {
    const current = approvalRulesToForm(rules);
    return (Object.keys(current) as (keyof ApprovalRulesFormValues)[]).some(
      (key) => String(current[key]) !== String(form[key]),
    );
  }, [form, rules]);

  async function submit() {
    const { errors: localErrors } = validateApprovalRulesForm(form, rules);
    setErrors(localErrors);
    if (Object.keys(localErrors).length > 0) return;

    setBusy(true);
    try {
      await saveRules(form);
      toast.success(t("approvals.rulesSaved"));
    } catch (err) {
      toast.error(err instanceof AppError ? err.message || t("common.error") : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const errorFor = (field: keyof ApprovalRulesFormValues) => {
    const key = errors[field];
    return key ? t(`approvals.error.${key}` as never) : undefined;
  };

  if (loading && !rules) {
    return (
      <Card>
        <LoadingBlock label={t("common.loading")} />
      </Card>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("approvals.rulesTitle")}
        crumbs={[{ label: t("home.breadcrumb.settings"), to: "/settings" }, { label: t("approvals.rulesTitle") }]}
        subtitle={t("approvals.rulesSubtitle")}
        backTo="/settings"
        backLabel={t("settings.title")}
        actions={
          <>
            <Link
              to="/approvals"
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              {t("approvals.title")}
            </Link>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.refresh")}>
              ⟳
            </Button>
            {mayEdit ? (
              <Button onClick={() => void submit()} loading={busy} disabled={!dirty}>
                {t("approvals.saveRules")}
              </Button>
            ) : null}
          </>
        }
      />

      {!mayEdit ? (
        <Card className="mb-4">
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
            {t("approvals.rulesDenied")}
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Discount */}
        <Card>
          <SectionTitle>{t("approvals.kind.discount")}</SectionTitle>
          <label className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={form.discount_limit_enabled}
              disabled={!mayEdit}
              onChange={(e) => patch({ discount_limit_enabled: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            {t("approvals.enabled")}
          </label>
          <div className="mt-3">
            <Field
              label={t("approvals.discountLimit")}
              hint={t("approvals.discountLimitHint")}
              error={errorFor("discount_limit_percent")}
              htmlFor="approval-discount-limit"
            >
              <TextInput
                id="approval-discount-limit"
                type="number"
                min={0}
                max={100}
                step="0.5"
                value={form.discount_limit_percent}
                disabled={!mayEdit || !form.discount_limit_enabled}
                invalid={Boolean(errors.discount_limit_percent)}
                onChange={(e) => patch({ discount_limit_percent: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        {/* Refund */}
        <Card>
          <SectionTitle>{t("approvals.kind.refund")}</SectionTitle>
          <label className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={form.refund_limit_enabled}
              disabled={!mayEdit}
              onChange={(e) => patch({ refund_limit_enabled: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            {t("approvals.enabled")}
          </label>
          <div className="mt-3">
            <Field
              label={t("approvals.refundLimit")}
              hint={t("approvals.refundLimitHint")}
              error={errorFor("refund_limit_amount")}
              htmlFor="approval-refund-limit"
            >
              <TextInput
                id="approval-refund-limit"
                type="number"
                min={0}
                step="50"
                value={form.refund_limit_amount}
                disabled={!mayEdit || !form.refund_limit_enabled}
                invalid={Boolean(errors.refund_limit_amount)}
                onChange={(e) => patch({ refund_limit_amount: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        {/* Expense */}
        <Card>
          <SectionTitle>{t("approvals.kind.expense")}</SectionTitle>
          <label className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={form.expense_limit_enabled}
              disabled={!mayEdit}
              onChange={(e) => patch({ expense_limit_enabled: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            {t("approvals.enabled")}
          </label>
          <div className="mt-3">
            <Field
              label={t("approvals.expenseLimit")}
              hint={t("approvals.expenseLimitHint")}
              error={errorFor("expense_limit_amount")}
              htmlFor="approval-expense-limit"
            >
              <TextInput
                id="approval-expense-limit"
                type="number"
                min={0}
                step="50"
                value={form.expense_limit_amount}
                disabled={!mayEdit || !form.expense_limit_enabled}
                invalid={Boolean(errors.expense_limit_amount)}
                onChange={(e) => patch({ expense_limit_amount: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        {/* Price changes */}
        <Card>
          <SectionTitle>{t("approvals.kind.price_change")}</SectionTitle>
          <label className="mt-2 flex items-start gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={form.price_change_approval_enabled}
              disabled={!mayEdit}
              onChange={(e) => patch({ price_change_approval_enabled: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              {t("approvals.priceChangeRule")}
              <span className="mt-1 block text-xs font-normal text-slate-500">
                {t("approvals.priceChangeRuleHint")}
              </span>
            </span>
          </label>
        </Card>
      </div>

      <Card className="mt-4">
        <p className="text-xs text-slate-500">
          {rules.updated_at ? (
            <>
              {rules.updated_by_name
                ? t("approvals.rulesUpdatedBy", { name: rules.updated_by_name })
                : t("approvals.rules")}{" "}
              · <span dir="ltr">{date(rules.updated_at)}</span>
            </>
          ) : (
            t("approvals.rulesSubtitle")
          )}
        </p>
      </Card>
    </div>
  );
}
