import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EditIcon,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PlusIcon,
  SearchIcon,
  StatTile,
  TextInput,
  useToast,
} from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { canAct } from "@/lib/permissions/enforce";
import { capabilityLabelKey, capabilityGroupLabelKey, groupOfCapability } from "@/lib/permissions/catalog";
import { actionTally } from "@/lib/permissions/preview";
import { CAPABILITIES } from "@/lib/permissions/roles";
import { customRoleName, type CustomRole } from "@/lib/permissions/customRoles";
import { useSettings } from "../hooks/SettingsProvider";
import { RoleFormModal } from "../components/RoleFormModal";
import { AccessPreviewModal } from "../components/AccessPreviewModal";
import { queryRoles } from "../services/userQuery";
import { roleLabel } from "../components/UserStatusBadge";
import type { RoleFormState } from "../types";

/** How many permission chips a card shows before collapsing into "+N". */
const CHIPS_PER_CARD = 10;

/**
 * Settings → Roles & permissions.
 *
 * The five system roles cover a shop with one owner and two cashiers. They do not
 * cover "the accountant who may read every report and export them but must never
 * touch the register", and the answer to that is not a sixth hard-coded role — it
 * is this screen.
 *
 * What it shows besides the list, per card: how many permissions the role holds
 * out of the whole catalogue, what kinds of act they are (nine reads and two
 * approvals reads as a job; forty edits reads as a mistake), how many people wear
 * it, and what deactivating it would do to them — they fall back to the role's
 * base matrix, so nobody is locked out, but their permissions change immediately.
 * Those numbers are the difference between an admin making an informed change and
 * an admin wondering why the warehouse stopped being able to adjust stock.
 *
 * Phase 17 added three ways to work with a role instead of only editing it:
 * search (by name, key or the permissions it holds), duplicate (the honest way to
 * make "the accountant, but for the new branch"), and preview (what the role would
 * see — computed, never applied; see `AccessPreviewModal`).
 */
export function RolesPage() {
  const { t, lang, num } = useI18n();
  const toast = useToast();
  const { users, roles, loading, error, refresh, saveRole, toggleRoleActive } = useSettings();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<CustomRole | null>(null);
  const [pendingToggle, setPendingToggle] = useState<CustomRole | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRoleId, setPreviewRoleId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const canManage = canAct("manage_roles");

  // Search matches the permissions a role holds as well as its names, so "which
  // role can approve a refund?" is answered from this screen.
  const visible = useMemo(
    () => queryRoles(roles, query, (capability) => t(capabilityLabelKey(capability) as Parameters<typeof t>[0])),
    [roles, query, t],
  );

  const stats = useMemo(() => {
    const active = roles.filter((role) => role.active).length;
    const assigned = users.filter((user) => Boolean(user.custom_role_id)).length;
    return { total: roles.length, active, inactive: roles.length - active, assigned };
  }, [roles, users]);

  /** Who wears each role, so the card can say it without another pass. */
  const assignments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const user of users) {
      if (!user.custom_role_id) continue;
      counts.set(user.custom_role_id, (counts.get(user.custom_role_id) ?? 0) + 1);
    }
    return counts;
  }, [users]);

  function errorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.startsWith("settings.") || raw.startsWith("permissions.")
      ? t(raw as Parameters<typeof t>[0])
      : raw;
  }

  async function submitForm(form: RoleFormState) {
    try {
      // A duplicate arrives with no id, so it goes through the create path — and
      // `createRole` writes its own `role.created` audit entry, listing the
      // capabilities it was born with. Duplicating is not a privileged shortcut
      // around the audit log; it is the same act with the boxes pre-ticked.
      const saved = await saveRole(form);
      toast.success(
        `${form.id ? t("settings.roles.updatedToast") : t("settings.roles.createdToast")} · ${saved.name_en}`,
      );
      setFormOpen(false);
      setEditing(null);
      setDuplicateOf(null);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  }

  function openDuplicate(role: CustomRole) {
    setEditing(null);
    setDuplicateOf(role);
    setFormOpen(true);
  }

  function openPreview(roleId: string | null) {
    setPreviewRoleId(roleId);
    setPreviewOpen(true);
  }

  async function confirmToggle() {
    if (!pendingToggle) return;
    setBusy(true);
    try {
      const saved = await toggleRoleActive(pendingToggle);
      toast.success(
        `${saved.active ? t("settings.roles.activatedToast") : t("settings.roles.deactivatedToast")} · ${saved.name_en}`,
      );
      setPendingToggle(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Group a role's capabilities for the card summary: "Sales floor · 4". */
  function groupCounts(role: CustomRole): Array<{ key: string; count: number }> {
    const counts = new Map<string, number>();
    for (const capability of role.capabilities) {
      const group = groupOfCapability(capability);
      const key = group ? group.key : "other";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([key, count]) => ({ key, count }));
  }

  return (
    <div>
      <PageHeader
        title={t("settings.roles.title")}
        crumbs={[{ label: t("home.breadcrumb.settings"), to: "/settings" }, { label: t("settings.roles.title") }]}
        subtitle={t("settings.roles.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            <Button variant="secondary" onClick={() => openPreview(null)}>
              👁
              {t("settings.preview.open")}
            </Button>
            <Button
              disabled={!canManage}
              onClick={() => {
                setEditing(null);
                setDuplicateOf(null);
                setFormOpen(true);
              }}
            >
              <PlusIcon />
              {t("settings.roles.add")}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label={t("settings.roles.stat.total")} value={num(stats.total)} tone="primary" />
        <StatTile label={t("settings.roles.stat.active")} value={num(stats.active)} tone="success" />
        <StatTile label={t("settings.roles.stat.inactive")} value={num(stats.inactive)} tone="danger" />
        <StatTile label={t("settings.roles.stat.assigned")} value={num(stats.assigned)} tone="info" />
      </div>

      <Card className="mb-4 space-y-2">
        <p className="text-xs font-medium text-slate-700">{t("settings.roles.replacesHint")}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <TextInput
            type="search"
            value={query}
            leading={<SearchIcon />}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("settings.roles.search")}
            aria-label={t("settings.roles.search")}
            className="sm:max-w-sm"
          />
          {query.trim() ? (
            <span className="text-[11px] font-semibold text-slate-500">
              {t("settings.roles.showing", { count: num(visible.length), total: num(roles.length) })}
            </span>
          ) : null}
        </div>
      </Card>

      {error ? (
        <ErrorState
          title={t("common.error")}
          message={errorMessage(error)}
          retryLabel={t("common.retry")}
          onRetry={() => void refresh()}
        />
      ) : loading ? (
        <div className="alyq-card">
          <LoadingBlock label={t("common.loading")} />
        </div>
      ) : roles.length === 0 ? (
        <Card>
          <EmptyState
            icon="🛡️"
            title={t("settings.roles.empty")}
            description={t("settings.roles.emptyHint")}
            action={
              canManage ? (
                <Button
                  onClick={() => {
                    setEditing(null);
                    setDuplicateOf(null);
                    setFormOpen(true);
                  }}
                >
                  <PlusIcon />
                  {t("settings.roles.add")}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState icon="🔍" title={t("settings.roles.noResults")} description={t("settings.roles.search")} />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visible.map((role) => {
            const assigned = assignments.get(role.id) ?? 0;
            const chips = role.capabilities.slice(0, CHIPS_PER_CARD);
            const rest = role.capabilities.length - chips.length;
            const tally = actionTally(role.capabilities);
            return (
              <Card key={role.id} className={role.active ? "" : "opacity-80"}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-bold text-slate-900">{customRoleName(role, lang)}</h3>
                      {role.is_system ? <Badge tone="neutral">{t("settings.roles.systemBadge")}</Badge> : null}
                      <Badge tone={role.active ? "success" : "danger"}>
                        {role.active ? t("common.active") : t("common.inactive")}
                      </Badge>
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-medium text-slate-600">
                      <span dir="ltr" className="font-mono">
                        {role.key}
                      </span>
                      <span aria-hidden>·</span>
                      <span>
                        {t("settings.roles.col.base")}: {roleLabel(t, role.base_role)}
                      </span>
                      <span aria-hidden>·</span>
                      <span>{t("settings.roles.assignedHint", { count: num(assigned) })}</span>
                      <span aria-hidden>·</span>
                      <span>
                        {t("settings.preview.held", {
                          count: num(role.capabilities.length),
                          total: num(CAPABILITIES.length),
                        })}
                      </span>
                    </p>
                    {role.description_en || role.description_ar ? (
                      <p className="mt-1.5 text-xs font-medium text-slate-600">
                        {lang === "ar" ? role.description_ar || role.description_en : role.description_en}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {/* Preview is offered for system roles too, and to everybody
                        who can open this screen: it discloses nothing the picker
                        does not, and it never changes any authority. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t("settings.preview.open")}
                      onClick={() => openPreview(role.id)}
                    >
                      👁
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canManage}
                      title={t("settings.roles.duplicate")}
                      onClick={() => openDuplicate(role)}
                    >
                      ⧉
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canManage || role.is_system}
                      title={t("settings.roles.edit")}
                      onClick={() => {
                        setEditing(role);
                        setDuplicateOf(null);
                        setFormOpen(true);
                      }}
                    >
                      <EditIcon />
                    </Button>
                    <Button
                      size="sm"
                      variant={role.active ? "ghost" : "subtle"}
                      disabled={!canManage || role.is_system}
                      onClick={() => setPendingToggle(role)}
                    >
                      {role.active ? t("common.deactivate") : t("common.activate")}
                    </Button>
                  </div>
                </div>

                {/* The shape of the job: how many reads, writes, approvals and
                    exports this role is. Two roles with the same count can be
                    very different jobs, and this is what tells them apart. */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {tally.map((entry) => (
                    <span
                      key={entry.action}
                      className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-100"
                    >
                      {t(`permissions.action.${entry.action}` as Parameters<typeof t>[0])} · {num(entry.count)}
                    </span>
                  ))}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {groupCounts(role).map((group) => (
                    <span
                      key={group.key}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600"
                    >
                      {t(capabilityGroupLabelKey(group.key as never) as Parameters<typeof t>[0])} · {num(group.count)}
                    </span>
                  ))}
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {chips.map((capability) => (
                    <Badge key={capability} tone="neutral">
                      {t(capabilityLabelKey(capability) as Parameters<typeof t>[0])}
                    </Badge>
                  ))}
                  {rest > 0 ? (
                    <Badge tone="neutral">
                      +{num(rest)}
                    </Badge>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <RoleFormModal
        open={formOpen}
        editing={editing}
        duplicateOf={duplicateOf}
        existing={roles}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setDuplicateOf(null);
        }}
        onSubmit={submitForm}
      />

      <AccessPreviewModal
        open={previewOpen}
        roles={roles}
        users={users}
        initialRoleId={previewRoleId}
        onClose={() => {
          setPreviewOpen(false);
          setPreviewRoleId(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingToggle)}
        loading={busy}
        tone={pendingToggle?.active ? "danger" : "primary"}
        title={
          pendingToggle?.active
            ? t("settings.roles.deactivateConfirmTitle")
            : t("settings.roles.activateConfirmTitle")
        }
        body={
          pendingToggle
            ? pendingToggle.active
              ? t("settings.roles.deactivateConfirmBody", {
                  count: num(assignments.get(pendingToggle.id) ?? 0),
                })
              : t("settings.roles.activateConfirmBody")
            : ""
        }
        confirmLabel={pendingToggle?.active ? t("common.deactivate") : t("common.activate")}
        onConfirm={() => void confirmToggle()}
        onCancel={() => setPendingToggle(null)}
      />
    </div>
  );
}
