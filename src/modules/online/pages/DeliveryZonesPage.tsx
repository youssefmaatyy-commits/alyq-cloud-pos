/**
 * Delivery Zones — the admin owns the per-governorate shipping prices.
 *
 * Each row is a choice the checkout offers (Ismailia free, Cairo 70, …) with
 * its own fee, minimum and free-shipping threshold. Editing a fee here prices
 * the next checkout — no code, no deploy. Disabling a zone refuses new
 * delivery orders to it; deleting one is refused by the database while orders
 * reference it (and is audited either way).
 *
 * Reads are public (the storefront renders the choices); every write is
 * RLS-gated on `manage_website` server-side, and this screen hides entirely
 * without it. Writes audit themselves through the `promo_audit` trigger.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { canActAs } from "@/lib/permissions/enforce";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Modal,
  TextInput,
  ToggleSwitch,
  useToast,
} from "@/components/ui";
import { getWebsiteRepository } from "../data";
import { toOnlineError, type OnlineErrorCode } from "../data/repository";
import type { DeliveryZone } from "../types";

export function DeliveryZonesPage() {
  const { t, money } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const repository = useMemo(() => getWebsiteRepository(), []);
  const canManage = canActAs(user, "manage_website");

  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<OnlineErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DeliveryZone | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeliveryZone | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setZones(await repository.listDeliveryZones());
      setError(null);
    } catch (caught) {
      setError(toOnlineError(caught).code);
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    if (canManage) void load();
    else setLoading(false);
  }, [canManage, load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await repository.saveDeliveryZone(draft);
      setZones((current) => {
        const index = current.findIndex((entry) => entry.id === saved.id);
        if (index < 0) return [...current, saved];
        const next = [...current];
        next[index] = saved;
        return next;
      });
      setDraft(null);
      toast.success(t("online.zones.saved"));
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await repository.deleteDeliveryZone(confirmDelete.id);
      setZones((current) => current.filter((entry) => entry.id !== confirmDelete.id));
      toast.push(t("online.zones.deleted"), "info");
      setConfirmDelete(null);
    } catch (caught) {
      toast.error(t(`online.error.${toOnlineError(caught).code}`));
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <div>
        <PageHeader
          title={t("online.zones.title")}
          crumbs={[{ label: t("home.breadcrumb.online"), to: "/online" }, { label: t("online.zones.title") }]}
          subtitle={t("online.zones.subtitle")}
        />
        <Card>
          <EmptyState icon="🔒" title={t("online.settings.noAccess")} description={t("online.settings.noAccessHint")} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("online.zones.title")}
        crumbs={[{ label: t("home.breadcrumb.online"), to: "/online" }, { label: t("online.zones.title") }]}
        subtitle={t("online.zones.subtitle")}
        actions={
          <Button
            data-testid="zone-new"
            onClick={() =>
              setDraft({
                id: "",
                key: "",
                name_en: "",
                name_ar: "",
                governorate_key: null,
                shipping_fee: 0,
                minimum_order_amount: 0,
                free_shipping_threshold: null,
                estimated_delivery_text_en: null,
                estimated_delivery_text_ar: null,
                enabled: true,
                sort_order: zones.length * 10,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
            }
          >
            {t("online.zones.new")}
          </Button>
        }
      />

      {error ? (
        <ErrorState
          title={t("common.error")}
          message={t(`online.error.${error}`)}
          retryLabel={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : zones.length === 0 ? (
        <Card>
          <EmptyState icon="🚚" title={t("online.zones.empty")} description={t("online.zones.emptyHint")} />
        </Card>
      ) : (
        <div className="alyq-card overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="zones-table">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-bold uppercase tracking-wider text-stone-600">
                <th className="px-4 py-3 text-start font-semibold">{t("online.zones.colZone")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("online.zones.colFee")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("online.zones.colMinimum")}</th>
                <th className="px-3 py-3 text-end font-semibold">{t("online.zones.colFreeAbove")}</th>
                <th className="px-3 py-3 text-start font-semibold">{t("online.zones.colStatus")}</th>
                <th className="px-4 py-3 text-end font-semibold">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {zones.map((zone) => (
                <tr
                  key={zone.id}
                  data-testid={`zone-row-${zone.key}`}
                  className="border-b border-stone-50 transition-colors last:border-0 hover:bg-slate-50/60"
                >
                  <td className="px-4 py-3">
                    <p className="text-sm font-bold text-stone-900">
                      {zone.name_en || zone.name_ar}
                      <span className="ms-2 font-mono text-[10px] font-semibold text-stone-400" dir="ltr">
                        {zone.key}
                      </span>
                    </p>
                    <p className="text-xs text-stone-500">
                      {zone.name_ar && zone.name_en ? zone.name_ar : zone.estimated_delivery_text_en ?? ""}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-end text-sm font-bold tabular-nums text-stone-900">
                    {zone.shipping_fee === 0 ? t("online.zones.free") : money(zone.shipping_fee)}
                  </td>
                  <td className="px-3 py-3 text-end text-xs tabular-nums text-stone-600">
                    {zone.minimum_order_amount > 0 ? money(zone.minimum_order_amount) : "—"}
                  </td>
                  <td className="px-3 py-3 text-end text-xs tabular-nums text-stone-600">
                    {zone.free_shipping_threshold !== null ? money(zone.free_shipping_threshold) : "—"}
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={zone.enabled ? "success" : "danger"}>
                      {zone.enabled ? t("online.zones.enabled") : t("online.zones.disabled")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-end">
                    <div className="flex shrink-0 items-center justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setDraft(zone)}>
                        {t("common.edit")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(zone)}>
                        {t("common.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        size="lg"
        title={draft?.id ? t("online.zones.edit") : t("online.zones.new")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDraft(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              data-testid="zone-save"
              onClick={() => void save()}
              loading={busy}
              disabled={!draft || !draft.key.trim() || !draft.name_en.trim() || !draft.name_ar.trim()}
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("online.zones.key")} required hint={t("online.zones.keyHint")}>
                <TextInput
                  dir="ltr"
                  data-testid="zone-key"
                  disabled={draft.id !== ""}
                  value={draft.key}
                  onChange={(event) =>
                    setDraft({ ...draft, key: event.target.value.toLowerCase().replace(/\s+/g, "-") })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label={t("online.zones.sortOrder")}>
                <TextInput
                  type="number"
                  min={0}
                  step={10}
                  value={String(draft.sort_order)}
                  onChange={(event) =>
                    setDraft({ ...draft, sort_order: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field label={t("online.zones.nameEn")} required>
                <TextInput
                  dir="ltr"
                  value={draft.name_en}
                  onChange={(event) => setDraft({ ...draft, name_en: event.target.value })}
                />
              </Field>
              <Field label={t("online.zones.nameAr")} required>
                <TextInput
                  dir="rtl"
                  value={draft.name_ar}
                  onChange={(event) => setDraft({ ...draft, name_ar: event.target.value })}
                />
              </Field>
              <Field label={t("online.zones.governorate")} hint={t("online.zones.governorateHint")}>
                <TextInput
                  dir="ltr"
                  value={draft.governorate_key ?? ""}
                  placeholder="cairo"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      governorate_key: event.target.value.trim() ? event.target.value.trim().toLowerCase() : null,
                    })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label={t("online.zones.fee")} required>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  data-testid="zone-fee"
                  value={String(draft.shipping_fee)}
                  onChange={(event) =>
                    setDraft({ ...draft, shipping_fee: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field label={t("online.zones.minimum")} hint={t("online.zones.minimumHint")}>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={String(draft.minimum_order_amount)}
                  onChange={(event) =>
                    setDraft({ ...draft, minimum_order_amount: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
              </Field>
              <Field label={t("online.zones.freeAbove")} hint={t("online.zones.freeAboveHint")}>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft.free_shipping_threshold === null ? "" : String(draft.free_shipping_threshold)}
                  placeholder={t("online.zones.noThreshold")}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      free_shipping_threshold:
                        event.target.value.trim() === "" ? null : Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
              </Field>
              <Field label={t("online.zones.etaEn")}>
                <TextInput
                  dir="ltr"
                  value={draft.estimated_delivery_text_en ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, estimated_delivery_text_en: event.target.value || null })
                  }
                />
              </Field>
              <Field label={t("online.zones.etaAr")}>
                <TextInput
                  dir="rtl"
                  value={draft.estimated_delivery_text_ar ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, estimated_delivery_text_ar: event.target.value || null })
                  }
                />
              </Field>
            </div>

            <ToggleSwitch
              checked={draft.enabled}
              onChange={(checked) => setDraft({ ...draft, enabled: checked })}
              label={t("online.zones.enabled")}
              hint={t("online.zones.enableHint")}
            />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("online.zones.deleteTitle")}
        body={t("online.zones.deleteBody", { label: confirmDelete?.name_en ?? "" })}
        loading={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
