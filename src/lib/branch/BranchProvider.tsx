import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AppRole } from "@/lib/permissions/roles";
import { useAuth } from "@/lib/auth";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getConnectivitySnapshot, getConnectivityStatus } from "@/modules/pos/offline/connectivity";

export interface BranchAccess {
  id: string;
  code: string;
  name_en: string;
  name_ar: string;
  role: AppRole;
  custom_role_id: string | null;
  custom_role_name: string | null;
  active: boolean;
  is_current: boolean;
}

interface BranchContextValue {
  branches: readonly BranchAccess[];
  current: BranchAccess | null;
  loading: boolean;
  switching: boolean;
  error: string | null;
  switchBranch: (branchId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

const BranchContext = createContext<BranchContextValue | null>(null);

const DEMO_BRANCH: BranchAccess = {
  id: "demo-main",
  code: "main",
  name_en: "Main Branch",
  name_ar: "الفرع الرئيسي",
  role: "admin",
  custom_role_id: null,
  custom_role_name: null,
  active: true,
  is_current: true,
};

/**
 * Owns the active tenancy boundary above every business-data provider.
 *
 * A switch is authoritative first (RPC), then refreshes the auth identity so
 * all synchronous permission gates receive the selected membership's effective
 * set. Incrementing `revision` remounts the providers below this boundary: no
 * cache from branch A can remain visible while branch B is active.
 */
export function BranchProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [branches, setBranches] = useState<BranchAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(async () => {
    if (auth.mode === "demo") {
      setBranches([{ ...DEMO_BRANCH, role: auth.user?.role ?? "admin" }]);
      setError(null);
      setLoading(false);
      return;
    }
    const client = getSupabaseClient();
    if (!client) {
      setError("Branch service is not configured");
      setBranches([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error: queryError } = await client.rpc("get_my_branches");
      if (queryError) {
        setError(queryError.message);
        setBranches([]);
      } else {
        setBranches(((data as BranchAccess[]) ?? []).filter((branch) => branch.active));
        setError(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load branches");
      setBranches([]);
    } finally {
      setLoading(false);
    }
  }, [auth.mode, auth.user?.role]);

  useEffect(() => {
    void refresh();
  }, [refresh, auth.user?.active_branch_id]);

  const switchBranch = useCallback(async (branchId: string) => {
    const target = branches.find((branch) => branch.id === branchId && branch.active);
    if (!target) return false; // inaccessible branches are neither shown nor accepted.
    if (auth.mode === "demo" || target.is_current) return true;
    const connectivity = getConnectivitySnapshot();
    if (getConnectivityStatus() !== "online" || connectivity.backend !== "reachable" || connectivity.session !== "usable") {
      setError("Reconnect and refresh your session before switching branches");
      return false;
    }
    const client = getSupabaseClient();
    if (!client) return false;
    setSwitching(true);
    setError(null);
    try {
      const { error: switchError } = await client.rpc("switch_active_branch_with_audit", {
        p_branch_id: branchId,
      });
      if (switchError) throw switchError;
      if (!(await auth.refreshIdentity())) throw new Error("Session ended while switching branch");
      setBranches((current) => current.map((branch) => ({
        ...branch,
        is_current: branch.id === branchId,
      })));
      setRevision((value) => value + 1);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch branch");
      return false;
    } finally {
      setSwitching(false);
    }
  }, [auth, branches]);

  const current = useMemo(
    () => branches.find((branch) => branch.is_current)
      ?? branches.find((branch) => branch.id === auth.user?.active_branch_id)
      ?? null,
    [branches, auth.user?.active_branch_id],
  );

  const value = useMemo<BranchContextValue>(() => ({
    branches,
    current,
    loading,
    switching,
    error,
    switchBranch,
    refresh,
  }), [branches, current, loading, switching, error, switchBranch, refresh]);

  return (
    <BranchContext.Provider value={value}>
      <Fragment key={revision}>{children}</Fragment>
    </BranchContext.Provider>
  );
}

export function useBranch(): BranchContextValue {
  const value = useContext(BranchContext);
  if (!value) throw new Error("useBranch must be used inside <BranchProvider>");
  return value;
}
