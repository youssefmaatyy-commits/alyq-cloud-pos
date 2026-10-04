import { createContext, useContext } from "react";
import type { MobileRuntimeContext } from "./services/mobileRuntime";
import type { PushRegistrationState } from "./services/mobilePush";

export interface MobileContextValue {
  runtime: MobileRuntimeContext | null;
  network: "online" | "offline" | "unknown";
  pushState: PushRegistrationState;
  enablePush: () => Promise<void>;
  refreshNetwork: () => Promise<void>;
}

export const MobileContext = createContext<MobileContextValue | null>(null);
export function useMobile(): MobileContextValue {
  const value = useContext(MobileContext);
  if (!value) throw new Error("useMobile must be used inside MobileApp");
  return value;
}
