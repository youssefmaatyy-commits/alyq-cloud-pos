import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppError } from "@/modules/products/data/repository";
import { canAct } from "@/lib/permissions/enforce";
import type { CustomRole } from "@/lib/permissions/customRoles";
import { getSettingsMode, getSettingsRepository } from "../data";
import type { SettingsRepository } from "../data/repository";
import {
  assignCustomRole as assignCustomRoleRequest,
  countRoleAssignments,
  createRole,
  createUser,
  loadManagedRoles,
  loadManagedUsers,
  resetUserPassword,
  setRoleActive,
  setUserActive,
  updateRole,
  updateUser,
} from "../services/settingsService";
import type { ManagedUser, RoleFormState, UserFormState } from "../types";

export interface SettingsContextValue {
  mode: "supabase" | "demo";
  repository: SettingsRepository;
  users: ManagedUser[];
  roles: CustomRole[];
  loading: boolean;
  error: AppError | null;
  /** What the acting user may do here — the UI hides what these deny. */
  canManageUsers: boolean;
  canManageRoles: boolean;
  refresh: () => Promise<void>;
  /** Create (`form.id === null`) or update. */
  saveUser: (form: UserFormState) => Promise<ManagedUser>;
  toggleUserActive: (user: ManagedUser) => Promise<ManagedUser>;
  assignRole: (userId: string, customRoleId: string | null) => Promise<ManagedUser>;
  resetPassword: (userId: string, password: string, confirmPassword: string) => Promise<void>;
  /** Create (`form.id === null`) or update. */
  saveRole: (form: RoleFormState) => Promise<CustomRole>;
  toggleRoleActive: (role: CustomRole) => Promise<CustomRole>;
  userById: (id: string | null | undefined) => ManagedUser | undefined;
  roleById: (id: string | null | undefined) => CustomRole | undefined;
  assignmentsFor: (roleId: string) => number;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

/**
 * Holds the directory and the role list for the settings screens.
 *
 * Two things it is careful about:
 *
 *   · It only reads what the acting user may read. A role that can manage users
 *     but not roles gets the directory and an empty role list, rather than a
 *     request the database would refuse — the picker then offers nothing, which
 *     is the honest answer.
 *   · Mutations go through `services/settingsService`, never straight to the
 *     repository, so the capability check, the self-lockout guardrails and the
 *     audit entry happen on every path into the data.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const repository = useMemo(() => getSettingsRepository(), []);
  const mode = getSettingsMode();

  const canManageUsers = canAct("manage_users");
  const canManageRoles = canAct("manage_roles");

  // Mirrors so callbacks can read the current lists without being re-created on
  // every change (and so a mutation validates against what is on screen).
  const usersRef = useRef<ManagedUser[]>([]);
  const rolesRef = useRef<CustomRole[]>([]);
  useEffect(() => {
    usersRef.current = users;
  }, [users]);
  useEffect(() => {
    rolesRef.current = roles;
  }, [roles]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextUsers, nextRoles] = await Promise.all([
        canManageUsers ? loadManagedUsers() : Promise.resolve([] as ManagedUser[]),
        canManageRoles ? loadManagedRoles() : Promise.resolve([] as CustomRole[]),
      ]);
      setUsers(nextUsers);
      setRoles(nextRoles);
      setError(null);
    } catch (err) {
      setError(err instanceof AppError ? err : new AppError("DB", String(err)));
    } finally {
      setLoading(false);
    }
  }, [canManageUsers, canManageRoles]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const context = useCallback(
    () => ({ existing: usersRef.current, roles: rolesRef.current }),
    [],
  );

  const saveUser = useCallback(async (form: UserFormState) => {
    const saved = form.id ? await updateUser(form, context()) : await createUser(form, context());
    await refresh();
    return saved;
  }, [context, refresh]);

  const toggleUserActive = useCallback(
    async (user: ManagedUser) => {
      const saved = await setUserActive(user.id, !user.active, context());
      await refresh();
      return saved;
    },
    [context, refresh],
  );

  const assignRole = useCallback(
    async (userId: string, customRoleId: string | null) => {
      const saved = await assignCustomRoleRequest(userId, customRoleId, context());
      await refresh();
      return saved;
    },
    [context, refresh],
  );

  const resetPassword = useCallback(
    async (userId: string, password: string, confirmPassword: string) => {
      await resetUserPassword(userId, password, confirmPassword, context());
    },
    [context],
  );

  const saveRole = useCallback(
    async (form: RoleFormState) => {
      const roleContext = { existing: rolesRef.current };
      const saved = form.id
        ? await updateRole(form, roleContext)
        : await createRole(form, roleContext);
      await refresh();
      return saved;
    },
    [refresh],
  );

  const toggleRoleActive = useCallback(
    async (role: CustomRole) => {
      const saved = await setRoleActive(role.id, !role.active, { existing: rolesRef.current });
      await refresh();
      return saved;
    },
    [refresh],
  );

  const userById = useCallback(
    (id: string | null | undefined) => usersRef.current.find((user) => user.id === id),
    [],
  );
  const roleById = useCallback(
    (id: string | null | undefined) => rolesRef.current.find((role) => role.id === id),
    [],
  );
  const assignmentsFor = useCallback((roleId: string) => countRoleAssignments(usersRef.current, roleId), []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      mode,
      repository,
      users,
      roles,
      loading,
      error,
      canManageUsers,
      canManageRoles,
      refresh,
      saveUser,
      toggleUserActive,
      assignRole,
      resetPassword,
      saveRole,
      toggleRoleActive,
      userById,
      roleById,
      assignmentsFor,
    }),
    [
      mode,
      repository,
      users,
      roles,
      loading,
      error,
      canManageUsers,
      canManageRoles,
      refresh,
      saveUser,
      toggleUserActive,
      assignRole,
      resetPassword,
      saveRole,
      toggleRoleActive,
      userById,
      roleById,
      assignmentsFor,
    ],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}
