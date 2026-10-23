import { createContext, useContext } from "react";
import { EMPTY_PUSH_DIAGNOSTICS, type PushDiagnostics, type PushRegistrationState } from "@/modules/mobile/services/mobilePush";
import type { MobileRuntimeContext } from "@/modules/mobile/services/mobileRuntime";

export interface WebNotificationsContextValue {
  runtime: MobileRuntimeContext | null;
  pushState: PushRegistrationState;
  pushDiagnostics: PushDiagnostics;
  notificationUnreadCount: number;
  notificationRevision: number;
  enablePush: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  deactivatePush: () => Promise<void>;
}

const DEFAULT_VALUE: WebNotificationsContextValue = {
  runtime: null,
  pushState: "unsupported",
  pushDiagnostics: EMPTY_PUSH_DIAGNOSTICS,
  notificationUnreadCount: 0,
  notificationRevision: 0,
  enablePush: async () => undefined,
  refreshNotifications: async () => undefined,
  deactivatePush: async () => undefined,
};

export const WebNotificationsContext = createContext<WebNotificationsContextValue>(DEFAULT_VALUE);

export function useWebNotifications(): WebNotificationsContextValue {
  return useContext(WebNotificationsContext);
}
