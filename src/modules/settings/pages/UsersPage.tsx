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
  SelectInput,
  StatTile,
  TextInput,
  useToast,
} from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth/hooks/AuthProvider";
import { canAct } from "@/lib/permissions/enforce";
import { APP_ROLES } from "@/lib/permissions/roles";
import { useSettings } from "../hooks/SettingsProvider";
import { queryUsers, sortUsers, summarizeUsers } from "../services/userQuery";
import { UserFormModal } from "../components/UserFormModal";
import { ResetPasswordModal } from "../components/ResetPasswordModal";
import { UserRoleBadge, UserStatusBadge, roleLabel } from "../components/UserStatusBadge";
import {
  DEFAULT_USER_SORT,
  EMPTY_USER_FILTERS,
  type ManagedUser,
  UserFiltersValue,
  type UserSortKey,
  type UserSortValue,
} from "../types";

/**
 * Settings → Users.
 *
 * The screen the specification asks for: who exists, what each person may do,
 * whether they can sign in, when they were created and when they last did. Every
 * action on it (create, edit, activate, deactivate, reset a password, assign a
 * role) goes through the settings service, which asserts the capability, applies
 * the self-lockout guardrails and writes the audit entry — so this page cannot be
 * the only thing standing between a curious cashier and somebody else's account.
 *
 * Buttons are hidden when the acting user lacks the capability. That is a
 * courtesy, not the control: the service refuses the same call.
 */
export function UsersPage() {
  const { t, date, num } = useI18n();
  const toast = useToast();
  const { user: actor, mode } = useAuth();
  const { users, roles, loading, error, refresh, saveUser, toggleUserActive, resetPassword } = useSettings();

  const [filters, setFilters] = useState<UserFiltersValue>(EMPTY_USER_FILTERS);
  const [sort, setSort] = useState<UserSortValue>(DEFAULT_USER_SORT);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [resetting, setResetting] = useState<ManagedUser | null>(null);
  const [pendingToggle, setPendingToggle] = useState<ManagedUser | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => sortUsers(queryUsers(users, filters), sort), [users, filters, sort]);
  const summary = useMemo(() => summarizeUsers(users), [users]);
  const canManage = canAct("manage_users");

  function toggleSort(key: UserSortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  }

  async function submitForm(form: Parameters<typeof saveUser>[0]) {
    try {
      const saved = await saveUser(form);
      toast.success(
        `${form.id ? t("settings.users.updatedToast") : t("settings.users.createdToast")} · ${saved.name}`,
      );
      setFormOpen(false);
      setEditing(null);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  }

  async function confirmToggle() {
    if (!pendingToggle) return;
    setBusy(true);
    try {
      const saved = await toggleUserActive(pendingToggle);
      toast.success(
        `${saved.active ? t("settings.users.activatedToast") : t("settings.users.deactivatedToast")} · ${saved.name}`,
      );
      setPendingToggle(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(password: string, confirm: string) {
    if (!resetting) return;
    try {
      await resetPassword(resetting.id, password, confirm);
      toast.success(`${t("settings.users.reset.success")} · ${resetting.name}`);
      setResetting(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  /** An AppError carries an i18n key in `message`; anything else is shown as-is. */
  function errorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const key = raw as Parameters<typeof t>[0];
    // Only translate our own keys; a database message must not be guessed at.
    return raw.startsWith("settings.") || raw.startsWith("permissions.") ? t(key) : raw;
  }

  const headerCell = (key: UserSortKey, label: string) => (
    <th className="px-3 py-2 text-start font-bold">
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-indigo-700"
        aria-label={`${label} ${sort.key === key ? sort.direction : "asc"}`}
      >
        {label}
        <span aria-hidden className="text-[9px]">
          {sort.key === key ? (sort.direction === "asc" ? "▲" : "▼") : "◇"}
        </span>
      </button>
    </th>
  );

  return (
    <div>
      <PageHeader
        title={t("settings.users.title")}
        subtitle={t("settings.users.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => void refresh()} title={t("common.retry")}>
              ⟳
            </Button>
            <Button
              disabled={!canManage}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <PlusIcon />
              {t("settings.users.add")}
            </Button>
          </>
        }
      />

      {mode === "demo" ? (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          {t("settings.users.demoNotice")}
        </p>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatTile label={t("settings.users.stat.total")} value={num(summary.total)} tone="primary" />
        <StatTile label={t("settings.users.stat.active")} value={num(summary.active)} tone="success" />
        <StatTile label={t("settings.users.stat.inactive")} value={num(summary.inactive)} tone="danger" />
        <StatTile
          label={t("settings.users.stat.neverLoggedIn")}
          value={num(summary.neverSignedIn)}
          tone="warning"
          hint={t("settings.users.neverLoggedIn")}
        />
      </div>

      <Card className="mb-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="w-full lg:max-w-sm">
            <TextInput
              type="search"
              value={filters.search}
              leading={<SearchIcon />}
              aria-label={t("common.search")}
              placeholder={t("settings.users.searchPlaceholder")}
              onChange={(event) => setFilters((f) => ({ ...f, search: event.target.value }))}
            />
          </div>
          <div className="w-full sm:w-44">
            <SelectInput
              value={filters.role}
              aria-label={t("settings.users.col.role")}
              onChange={(event) =>
                setFilters((f) => ({ ...f, role: event.target.value as UserFiltersValue["role"] }))
              }
            >
              <option value="all">{t("settings.users.allRoles")}</option>
              {APP_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(t, role)}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="w-full sm:w-44">
            <SelectInput
              value={filters.status}
              aria-label={t("settings.users.col.status")}
              onChange={(event) =>
                setFilters((f) => ({ ...f, status: event.target.value as UserFiltersValue["status"] }))
              }
            >
              <option value="all">{t("settings.users.allStatuses")}</option>
              <option value="active">{t("settings.users.status.active")}</option>
              <option value="inactive">{t("settings.users.status.inactive")}</option>
            </SelectInput>
          </div>
          <div className="w-full sm:w-52">
            <SelectInput
              value={filters.custom_role_id}
              aria-label={t("settings.users.col.customRole")}
              onChange={(event) => setFilters((f) => ({ ...f, custom_role_id: event.target.value }))}
            >
              <option value="all">{t("settings.users.allCustomRoles")}</option>
              <option value="none">{t("settings.users.noCustomRole")}</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name_en}
                </option>
              ))}
            </SelectInput>
          </div>
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
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="👥"
            title={t("settings.users.empty")}
            description={t("settings.users.emptyHint")}
            action={
              canManage ? (
                <Button
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  <PlusIcon />
                  {t("settings.users.add")}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="alyq-card overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] text-slate-600">
                {headerCell("name", t("settings.users.col.name"))}
                {headerCell("username", t("settings.users.col.username"))}
                <th className="px-3 py-2 text-start font-bold uppercase tracking-wider">
                  {t("settings.users.col.contact")}
                </th>
                {headerCell("role", t("settings.users.col.role"))}
                {headerCell("active", t("settings.users.col.status"))}
                {headerCell("created_at", t("settings.users.col.created"))}
                {headerCell("last_login_at", t("settings.users.col.lastLogin"))}
                <th className="px-3 py-2 text-start font-bold uppercase tracking-wider">
                  {t("settings.users.col.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => {
                const isSelf = actor?.id === user.id;
                return (
                  <tr
                    key={user.id}
                    className={`border-b border-slate-100 last:border-0 ${user.active ? "" : "bg-rose-50/40"}`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900">{user.name}</span>
                        {isSelf ? <Badge tone="info">{t("settings.users.you")}</Badge> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span dir="ltr" className="font-mono text-xs text-slate-700">
                        {user.username}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="space-y-0.5 text-xs text-slate-700">
                        {user.email ? (
                          <div dir="ltr" className="text-start">
                            {user.email}
                          </div>
                        ) : null}
                        {user.phone ? (
                          <div dir="ltr" className="text-start text-slate-500">
                            {user.phone}
                          </div>
                        ) : null}
                        {!user.email && !user.phone ? <span className="text-slate-400">—</span> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <UserRoleBadge user={user} />
                    </td>
                    <td className="px-3 py-2.5">
                      <UserStatusBadge active={user.active} />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">{date(user.created_at)}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">
                      {user.last_login_at ? (
                        date(user.last_login_at)
                      ) : (
                        <span className="font-medium text-slate-400">{t("settings.users.neverLoggedIn")}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canManage}
                          title={t("settings.users.edit")}
                          onClick={() => {
                            setEditing(user);
                            setFormOpen(true);
                          }}
                        >
                          <EditIcon />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canManage}
                          title={t("settings.users.reset.title")}
                          onClick={() => setResetting(user)}
                        >
                          🔑
                        </Button>
                        <Button
                          size="sm"
                          variant={user.active ? "ghost" : "subtle"}
                          // The self-lockout guardrail is visible, not discovered
                          // after a refused request.
                          disabled={!canManage || isSelf}
                          title={
                            user.active
                              ? t("settings.users.deactivateConfirmTitle")
                              : t("settings.users.activateConfirmTitle")
                          }
                          onClick={() => setPendingToggle(user)}
                        >
                          {user.active ? t("common.deactivate") : t("common.activate")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <UserFormModal
        open={formOpen}
        editing={editing}
        existing={users}
        roles={roles}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={submitForm}
      />

      <ResetPasswordModal
        open={Boolean(resetting)}
        user={resetting}
        onClose={() => setResetting(null)}
        onSubmit={submitReset}
      />

      <ConfirmDialog
        open={Boolean(pendingToggle)}
        loading={busy}
        tone={pendingToggle?.active ? "danger" : "primary"}
        title={
          pendingToggle?.active
            ? t("settings.users.deactivateConfirmTitle")
            : t("settings.users.activateConfirmTitle")
        }
        body={
          pendingToggle
            ? t(
                pendingToggle.active
                  ? "settings.users.deactivateConfirmBody"
                  : "settings.users.activateConfirmBody",
                { name: `${pendingToggle.name} (${pendingToggle.username})` },
              )
            : ""
        }
        confirmLabel={pendingToggle?.active ? t("common.deactivate") : t("common.activate")}
        onConfirm={() => void confirmToggle()}
        onCancel={() => setPendingToggle(null)}
      />
    </div>
  );
}
