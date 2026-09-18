/**
 * Settings → System → the Danger Zone (Phase 47).
 *
 * Three operations, one pattern, no shortcuts:
 *
 *   1. Clear Operational Data — day-to-day activity; the store setup stays.
 *   2. Reset Demo / Test Data — only in demo mode, where every row IS a
 *      fixture (the local repositories); hidden live, where nothing marks a
 *      row as demo, so the mode is never faked.
 *   3. Factory Reset — the catalogue and configuration too.
 *
 * Every operation runs the same deliberate sequence: choose scope → server
 * preview (real counts, no mutation) → review → current-password re-auth
 * (the existing auth service; the password never touches this page's state
 * beyond the in-flight call) → type the exact phrase → execute → result.
 * The destructive RPC checks the capability, the freshness window, the phrase,
 * the option keys and the protected admin AGAIN server-side — this screen is
 * the convenience, never the guard.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/AppShell";
import { Button, Card, Modal } from "@/components/ui";
import { Badge } from "@/components/ui/Feedback";
import { Field, TextInput } from "@/components/ui/FormControls";
import { useAuth } from "@/lib/auth/hooks/AuthProvider";
import { useI18n } from "@/lib/i18n/I18nProvider";
import type { TranslationKey } from "@/lib/i18n/dictionary";
import { Link, useNavigate } from "react-router-dom";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import {
  clearOperationalData,
  factoryReset,
  OPERATIONAL_PHRASE,
  reauthenticate,
  reportResetFailure,
  resetReauth,
  ResetError,
  systemResetPreview,
  FACTORY_PHRASE,
  type FactoryOptions,
  type OperationalOptions,
  type ResetPreview,
  type ResetResult,
} from "../services/systemReset";

type Stage = "scope" | "preview" | "reauth" | "phrase" | "running" | "done" | "failed";

interface GroupDef {
  key: string;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  danger?: boolean;
}

const OPERATIONAL_GROUPS: GroupDef[] = [
  { key: "sales", labelKey: "dz.group.sales", hintKey: "dz.group.sales.hint", danger: true },
  { key: "orders", labelKey: "dz.group.orders", hintKey: "dz.group.orders.hint", danger: true },
  { key: "returns", labelKey: "dz.group.returns", hintKey: "dz.group.returns.hint", danger: true },
  { key: "shifts", labelKey: "dz.group.shifts", hintKey: "dz.group.shifts.hint", danger: true },
  { key: "expenses", labelKey: "dz.group.expenses", hintKey: "dz.group.expenses.hint" },
  { key: "customers", labelKey: "dz.group.customers", hintKey: "dz.group.customers.hint", danger: true },
  { key: "movements", labelKey: "dz.group.movements", hintKey: "dz.group.movements.hint" },
  { key: "quantities", labelKey: "dz.group.quantities", hintKey: "dz.group.quantities.hint", danger: true },
];

const FACTORY_GROUPS: GroupDef[] = [
  { key: "products", labelKey: "dz.group.products", hintKey: "dz.group.products.hint", danger: true },
  { key: "categories", labelKey: "dz.group.categories", hintKey: "dz.group.categories.hint", danger: true },
  { key: "customers", labelKey: "dz.group.customers", hintKey: "dz.group.customers.hint", danger: true },
  { key: "website", labelKey: "dz.group.website", hintKey: "dz.group.website.hint", danger: true },
  { key: "branding", labelKey: "dz.group.branding", hintKey: "dz.group.branding.hint", danger: true },
  { key: "delivery_payment", labelKey: "dz.group.delivery", hintKey: "dz.group.delivery.hint" },
];

const num = (n: number): string => new Intl.NumberFormat("en-US").format(n);

export function SystemSettingsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const demoMode = !isSupabaseConfigured;

  // ── wizard state (one wizard, parameterized by mode) ─────────────────────
  const [mode, setMode] = useState<"operational" | "factory" | null>(null);
  const [stage, setStage] = useState<Stage>("scope");
  const [operational, setOperational] = useState<OperationalOptions>({
    sales: false, returns: false, orders: false, shifts: false,
    expenses: false, customers: false, movements: false, quantities: false,
  });
  const [factory, setFactory] = useState<FactoryOptions>({
    products: false, categories: false, customers: false,
    website: false, branding: false, delivery_payment: false,
  });
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [finalAck, setFinalAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // The verified current password, held only for the execute call that needs
  // it server-side (the RPC re-proves it) and wiped the moment execute ends.
  const verifiedPassword = useRef<string>("");
  const [result, setResult] = useState<ResetResult | null>(null);

  const expectedPhrase = mode === "factory" ? FACTORY_PHRASE : OPERATIONAL_PHRASE;
  const groups = mode === "factory" ? FACTORY_GROUPS : OPERATIONAL_GROUPS;

  const close = useCallback(() => {
    setMode(null);
    setStage("scope");
    setPreview(null);
    setPassword("");
    setPhrase("");
    setFinalAck(false);
    setError(null);
    setErrorCode(null);
    setResult(null);
    setBusy(false);
    resetReauth();
  }, []);

  const requestPreview = async () => {
    if (!mode) return;
    const chosen = mode === "factory" ? Object.fromEntries(Object.entries(factory).filter(([, v]) => v)) : Object.fromEntries(Object.entries(operational).filter(([, v]) => v));
    if (Object.keys(chosen).length === 0) {
      setError(t("dz.error.nothing"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await systemResetPreview(mode, chosen as Record<string, boolean>);
      setPreview(data);
      setStage("preview");
    } catch (err) {
      setError(err instanceof ResetError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitReauth = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await reauthenticate(user.username, password);
      if (!outcome.ok) {
        setError(t("dz.error.password"));
        return;
      }
      verifiedPassword.current = password;
      setPassword("");
      setStage("phrase");
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!mode) return;
    setBusy(true);
    setStage("running");
    setError(null);
    try {
      const data = mode === "factory"
        ? await factoryReset(factory, phrase, verifiedPassword.current)
        : await clearOperationalData(operational, phrase, verifiedPassword.current);
      setResult(data);
      setStage("done");
    } catch (err) {
      const message = err instanceof ResetError ? err.message : String(err);
      setErrorCode(err instanceof ResetError ? err.code : "RESET_FAILED");
      setError(message);
      setStage("failed");
      void reportResetFailure(mode, "execute", message);
    } finally {
      setBusy(false);
      verifiedPassword.current = "";
    }
  };

  // Post-reset: never linger on a stale page. The reload (demo) or navigation
  // (live) drops every cached list; the session survives both.
  useEffect(() => {
    if (stage !== "done" || !result) return;
    const timer = window.setTimeout(() => {
      if (result.needsReload) {
        window.location.hash = "#/";
        window.location.reload();
      } else {
        navigate("/", { replace: true });
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [stage, result, navigate]);

  const phraseOk = phrase.trim().toUpperCase() === expectedPhrase;

  const groupLabel = useCallback(
    (key: string) => {
      const def = groups.find((g) => g.key === key);
      return def ? t(def.labelKey) : key;
    },
    [groups, t],
  );

  return (
    <div>
      <PageHeader
        title={t("dz.title")}
        subtitle={t("dz.subtitle")}
        backTo="/settings"
        backLabel={t("common.back")}
      />

      {!demoMode ? (
        <Card className="mb-4 border-amber-300 bg-amber-50/60">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-black text-stone-900">{t("dz.backup.title")}</p>
              <p className="mt-0.5 text-xs font-medium text-stone-600">{t("dz.backup.hint")}</p>
            </div>
            <Link to="/settings/backup">
              <Button variant="secondary" size="sm" data-testid="dz-create-backup">
                {t("dz.backup.cta")}
              </Button>
            </Link>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3" data-testid="dz-cards">
        <Card className="flex flex-col">
          <Badge tone="warning">{t("dz.severity.high")}</Badge>
          <h2 className="mt-2 text-sm font-black text-stone-900">{t("dz.card.clear.title")}</h2>
          <p className="mt-1 flex-1 text-xs font-medium leading-relaxed text-stone-500">
            {t("dz.card.clear.desc")}
          </p>
          <p className="mt-2 text-[11px] font-semibold text-emerald-700">{t("dz.card.clear.keeps")}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            data-testid="dz-open-clear"
            onClick={() => { setMode("operational"); setStage("scope"); }}
          >
            {t("dz.card.clear.cta")}
          </Button>
        </Card>

        <Card className="flex flex-col">
          <Badge tone="neutral">{t("dz.severity.safe")}</Badge>
          <h2 className="mt-2 text-sm font-black text-stone-900">{t("dz.card.demo.title")}</h2>
          {demoMode ? (
            <>
              <p className="mt-1 flex-1 text-xs font-medium leading-relaxed text-stone-500">
                {t("dz.card.demo.desc")}
              </p>
              <p className="mt-2 text-[11px] font-semibold text-emerald-700">{t("dz.card.demo.keeps")}</p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                data-testid="dz-open-demo"
                onClick={() => { setMode("operational"); setStage("scope"); }}
              >
                {t("dz.card.demo.cta")}
              </Button>
            </>
          ) : (
            <p className="mt-1 flex-1 text-xs font-medium leading-relaxed text-stone-500">
              {t("dz.card.demo.unavailable")}
            </p>
          )}
        </Card>

        <Card className="flex flex-col border-red-300 bg-red-50/40">
          <Badge tone="danger">{t("dz.severity.critical")}</Badge>
          <h2 className="mt-2 text-sm font-black text-red-900">{t("dz.card.factory.title")}</h2>
          <p className="mt-1 flex-1 text-xs font-medium leading-relaxed text-red-800/80">
            {t("dz.card.factory.desc")}
          </p>
          <p className="mt-2 text-[11px] font-semibold text-red-700">{t("dz.card.factory.keeps")}</p>
          <Button
            variant="danger"
            size="sm"
            className="mt-3"
            data-testid="dz-open-factory"
            onClick={() => { setMode("factory"); setStage("scope"); }}
          >
            {t("dz.card.factory.cta")}
          </Button>
        </Card>
      </div>

      <p className="mt-4 text-[11px] font-medium leading-relaxed text-stone-400">
        {t("dz.footer.serverSide")}
      </p>

      {/* ── the wizard ─────────────────────────────────────────────────────── */}
      {mode ? (
        <Modal
          open
          onClose={close}
          title={mode === "factory" ? t("dz.wizard.factory.title") : t("dz.wizard.clear.title")}
          size="md"
        >
          {stage === "scope" ? (
            <div data-testid="dz-step-scope">
              <p className="text-xs font-medium text-stone-600">{t("dz.step1.hint")}</p>
              <div className="mt-3 space-y-2">
                {groups.map((group) => {
                  const checked = mode === "factory" ? factory[group.key as keyof FactoryOptions] : operational[group.key as keyof OperationalOptions];
                  const locked = mode === "operational" && group.key === "returns" && operational.sales;
                  return (
                    <label
                      key={group.key}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition ${
                        checked ? "border-red-300 bg-red-50/60" : "border-stone-200 bg-white hover:border-stone-300"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-red-700"
                        checked={Boolean(checked) || locked}
                        disabled={locked || busy}
                        onChange={(e) => {
                          const value = e.target.checked;
                          if (mode === "factory") {
                            setFactory((prev) => ({ ...prev, [group.key]: value }));
                          } else {
                            setOperational((prev) => ({ ...prev, [group.key]: value }));
                          }
                        }}
                        data-testid={`dz-option-${group.key}`}
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-black text-stone-900">
                          {t(group.labelKey)}
                          {locked ? <span className="ms-2 font-semibold text-stone-400">({t("dz.includedWithSales")})</span> : null}
                        </span>
                        <span className="mt-0.5 block text-[11px] font-medium text-stone-500">
                          {t(group.hintKey)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {mode === "factory" ? (
                <p className="mt-3 rounded-xl bg-stone-100 px-3 py-2 text-[11px] font-semibold text-stone-600">
                  {t("dz.factory.always")}
                </p>
              ) : null}
              <div className="mt-4 flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold text-stone-500">{t("dz.step1.defaults")}</p>
                <Button variant="danger" size="sm" data-testid="dz-preview" disabled={busy} onClick={() => void requestPreview()}>
                  {busy ? t("common.saving") : t("dz.step1.cta")}
                </Button>
              </div>
              {error ? <p className="mt-2 text-xs font-semibold text-red-700">{error}</p> : null}
            </div>
          ) : null}

          {stage === "preview" && preview ? (
            <div data-testid="dz-step-preview">
              <p className="text-xs font-medium text-stone-600">{t("dz.step2.hint")}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-red-200 bg-red-50/60 p-3">
                  <p className="text-[11px] font-black uppercase tracking-wider text-red-800">{t("dz.willDelete")}</p>
                  <ul className="mt-2 space-y-1" data-testid="dz-preview-delete">
                    {preview.delete.map((row) => (
                      <li key={row.group} className="flex items-center justify-between gap-2 text-xs font-semibold text-red-900">
                        <span>{groupLabel(row.group)}</span>
                        <span className="tabular-nums">{row.action === "reset" ? t("dz.resetToZero") : num(row.count)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                  <p className="text-[11px] font-black uppercase tracking-wider text-emerald-800">{t("dz.willKeep")}</p>
                  <ul className="mt-2 space-y-1" data-testid="dz-preview-preserve">
                    {preview.preserve.map((row) => (
                      <li key={row.group} className="flex items-center justify-between gap-2 text-xs font-semibold text-emerald-900">
                        <span>{groupLabel(row.group)}</span>
                        <span className="tabular-nums">{row.action === "reset" ? "—" : num(row.count)}</span>
                      </li>
                    ))}
                    <li className="flex items-center justify-between gap-2 text-xs font-semibold text-emerald-900">
                      <span>{t("dz.preserve.admin")}</span>
                      <span>{preview.protected_admin?.username ?? "—"}</span>
                    </li>
                  </ul>
                </div>
              </div>
              <p className="mt-2 text-[11px] font-medium text-stone-400">{preview.schema_note}</p>
              <div className="mt-4 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => { close(); }}>{t("common.cancel")}</Button>
                <Button variant="danger" size="sm" data-testid="dz-continue-review" onClick={() => setStage("reauth")}>
                  {t("dz.step2.cta")}
                </Button>
              </div>
            </div>
          ) : null}

          {stage === "reauth" ? (
            <div data-testid="dz-step-reauth">
              <p className="text-xs font-medium text-stone-600">{t("dz.step4.hint")}</p>
              <div className="mt-3">
                <Field label={t("dz.step4.password")}>
                  <TextInput
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    data-testid="dz-password"
                    disabled={busy}
                  />
                </Field>
              </div>
              {error ? <p className="mt-1 text-xs font-semibold text-red-700">{error}</p> : null}
              <div className="mt-4 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => { setStage("preview"); setError(null); }}>{t("common.back")}</Button>
                <Button variant="danger" size="sm" data-testid="dz-verify-password" disabled={busy || password.length === 0} onClick={() => void submitReauth()}>
                  {busy ? t("auth.signingIn") : t("dz.step4.cta")}
                </Button>
              </div>
            </div>
          ) : null}

          {stage === "phrase" ? (
            <div data-testid="dz-step-phrase">
              <p className="text-xs font-medium text-stone-600">{t("dz.step5.hint")}</p>
              <p className="mt-2 rounded-xl bg-stone-100 px-3 py-2 text-center font-mono text-sm font-black tracking-wider text-stone-900">
                {expectedPhrase}
              </p>
              <div className="mt-3">
                <Field label={t("dz.step5.phrase")}>
                  <TextInput
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    data-testid="dz-phrase-input"
                    autoComplete="off"
                    disabled={busy}
                  />
                </Field>
              </div>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs font-medium text-stone-700">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-red-700"
                  checked={finalAck}
                  onChange={(e) => setFinalAck(e.target.checked)}
                  data-testid="dz-final-ack"
                />
                {t("dz.step5.ack")}
              </label>
              <div className="mt-4 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => { setStage("reauth"); setPhrase(""); setFinalAck(false); }}>{t("common.back")}</Button>
                <Button
                  variant="danger"
                  size="sm"
                  data-testid={mode === "factory" ? "dz-execute-factory" : "dz-execute-clear"}
                  disabled={busy || !phraseOk || !finalAck}
                  onClick={() => void execute()}
                >
                  {mode === "factory" ? t("dz.execute.factory") : t("dz.execute.clear")}
                </Button>
              </div>
              <p className="mt-2 text-[11px] font-medium text-stone-400">{t("dz.step5.serverSide")}</p>
            </div>
          ) : null}

          {stage === "running" ? (
            <div className="py-6 text-center" data-testid="dz-step-running">
              <p className="text-sm font-black text-stone-900">{t("dz.running.title")}</p>
              <p className="mt-1 text-xs font-medium text-stone-500">{t("dz.running.hint")}</p>
            </div>
          ) : null}

          {stage === "done" && result ? (
            <div className="py-2 text-center" data-testid="dz-result">
              <p className="text-2xl">✓</p>
              <p className="mt-1 text-sm font-black text-emerald-800">{t("dz.done.title")}</p>
              <pre className="mt-3 max-h-40 overflow-y-auto rounded-xl bg-stone-100 p-3 text-start text-[11px] font-semibold text-stone-700">
                {JSON.stringify({ deleted: result.deleted, preserved: result.preserved }, null, 2)}
              </pre>
              <p className="mt-2 text-[11px] font-semibold text-stone-400">{t("dz.done.redirect")}</p>
            </div>
          ) : null}

          {stage === "failed" ? (
            <div className="py-2 text-center" data-testid="dz-failed">
              <p className="text-2xl">✗</p>
              <p className="mt-1 text-sm font-black text-red-800">{t("dz.failed.title")}</p>
              <p className="mt-1 text-xs font-semibold text-stone-600">{t("dz.failed.atomic")}</p>
              <p className="mt-3 rounded-xl bg-stone-100 p-3 text-[11px] font-semibold text-stone-700">
                {errorCode ?? ""} {error}
              </p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={close}>{t("common.close")}</Button>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
