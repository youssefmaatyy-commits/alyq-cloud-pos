import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useBranch } from "@/lib/branch";
import type { RegisterContextState } from "./types";
import { resolveRegisterContext } from "./services/registerService";

interface RegisterContextValue {
  state: RegisterContextState;
  loading: boolean;
  refresh: () => Promise<void>;
}

const RegisterContext = createContext<RegisterContextValue | null>(null);
const initial: RegisterContextState = { kind: "web", register: null, reason: null };

export function RegisterProvider({ children }: { children: React.ReactNode }) {
  const branch = useBranch();
  const branchId = branch.current?.id ?? null;
  const [state, setState] = useState<RegisterContextState>(initial);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await resolveRegisterContext(branchId));
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onChanged = () => { void refresh(); };
    window.addEventListener("alyq:register-changed", onChanged);
    return () => window.removeEventListener("alyq:register-changed", onChanged);
  }, [refresh]);

  const value = useMemo(() => ({ state, loading, refresh }), [loading, refresh, state]);
  return <RegisterContext.Provider value={value}>{children}</RegisterContext.Provider>;
}

export function useRegister(): RegisterContextValue {
  const value = useContext(RegisterContext);
  if (!value) throw new Error("useRegister must be used inside RegisterProvider");
  return value;
}
