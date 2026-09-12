/**
 * One new-order poller for the whole signed-in app.
 *
 * The sidebar badge and the Online Orders screen both need to know that a
 * website order arrived. If each mounted its own poller the shop would ask the
 * database twice as often and — worse — the two could disagree, so the badge
 * would say "2 new" above a screen showing none. This provider mounts the hook
 * once, above the shell, and both read the same state.
 *
 * It is enabled by capability rather than by route: a cashier who cannot manage
 * online orders must not have the shell querying them at all, because in live
 * mode row-level security would refuse every tick and the console would fill
 * with errors nobody can act on.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { hasCapability } from "@/lib/permissions/roles";
import {
  DEFAULT_NOTIFICATION_PREFS,
  EMPTY_NOTIFICATION_STATE,
  useOnlineNotifications,
  type OnlineNotificationState,
} from "./useOnlineNotifications";

const OnlineNotificationsContext = createContext<OnlineNotificationState | null>(null);

/**
 * Read the shared notification state.
 *
 * Outside the provider it returns an idle state rather than throwing: the shell
 * is mounted in a couple of harnesses that care about the POS and not about the
 * website, and a badge that quietly reads "nothing new" is correct there.
 */
export function useOnlineNotificationState(): OnlineNotificationState {
  return useContext(OnlineNotificationsContext) ?? EMPTY_NOTIFICATION_STATE;
}

export function OnlineNotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const enabled = hasCapability(user?.role, "manage_online_orders");
  const state = useOnlineNotifications(enabled);
  return (
    <OnlineNotificationsContext.Provider value={state}>{children}</OnlineNotificationsContext.Provider>
  );
}

export { DEFAULT_NOTIFICATION_PREFS };
export type { OnlineNotificationState };
