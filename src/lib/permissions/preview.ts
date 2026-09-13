/**
 * Access preview — "what would this role actually see?", answered without
 * touching the session.
 *
 * An admin building a role is guessing until they can see the result: which
 * screens appear in the sidebar, which buttons exist, and — just as important —
 * what has quietly disappeared. This module computes that answer from the same
 * three inputs the real gates use (system role, custom-role overlay, personal
 * exceptions) and the same two tables they read (`ROUTE_CAPABILITIES` for
 * screens, `CAPABILITY_GROUPS` for acts).
 *
 * It is a *projection*, not a bypass. Nothing here grants anything: it never
 * writes to the session, never calls `canAct`, and the values it returns are not
 * read by a single guard in the app. The route guard still refuses the URL, the
 * service still asserts the capability, and the database still refuses the row —
 * previewing a role you do not hold changes what you can see on this panel and
 * nothing else. That is also why the answer is computed rather than simulated: a
 * preview that could drift from the enforcement it describes would be worse than
 * no preview at all.
 *
 * The screen list carries paths and label keys only. The capability each screen
 * needs comes from `capabilityForPath()`, so this file cannot disagree with the
 * sidebar or the guard about what opens a screen — the selftest asserts every
 * path here is a real route in `App.tsx`.
 */
import { CAPABILITIES, type AppRole, type Capability } from "./roles";
import {
  CAPABILITY_GROUPS,
  PERMISSION_ACTIONS,
  actionsInGroup,
  capabilityGroupLabelKey,
  actionOfCapability,
  type PermissionAction,
} from "./catalog";
import { resolveCapabilities } from "./customRoles";
import { applyExceptions, type CapabilityExceptions } from "./exceptions";
import { capabilityForPath } from "./routes";

/** One sidebar destination, in the order the sidebar lists them. */
export interface PreviewScreen {
  readonly path: string;
  /** Dictionary key for the menu label — `nav.*`, the sidebar's own keys. */
  readonly labelKey: string;
}

export const PREVIEW_SCREENS: readonly PreviewScreen[] = [
  { path: "/", labelKey: "nav.dashboard" },
  { path: "/pos", labelKey: "nav.pos" },
  { path: "/pos/sales", labelKey: "nav.sales" },
  { path: "/customers", labelKey: "nav.customers" },
  { path: "/returns", labelKey: "nav.returns" },
  { path: "/refunds", labelKey: "nav.refunds" },
  { path: "/products", labelKey: "nav.products" },
  { path: "/categories", labelKey: "nav.categories" },
  { path: "/inventory", labelKey: "nav.inventory" },
  { path: "/inventory/movements", labelKey: "nav.movements" },
  { path: "/shifts", labelKey: "nav.shifts" },
  { path: "/shifts/history", labelKey: "nav.shiftHistory" },
  { path: "/expenses", labelKey: "nav.expenses" },
  { path: "/approvals", labelKey: "nav.approvals" },
  { path: "/reports", labelKey: "nav.reports" },
  { path: "/reports/advanced", labelKey: "nav.advancedReports" },
  { path: "/online/orders", labelKey: "nav.onlineOrders" },
  { path: "/online/reservations", labelKey: "nav.stockHolds" },
  { path: "/online/reports", labelKey: "nav.onlineReports" },
  { path: "/online/website", labelKey: "nav.websiteSettings" },
  { path: "/online/marketing", labelKey: "nav.marketing" },
  { path: "/online/content", labelKey: "nav.websiteContent" },
  { path: "/audit", labelKey: "nav.audit" },
  { path: "/settings", labelKey: "nav.settings" },
  { path: "/settings/users", labelKey: "nav.settingsUsers" },
  { path: "/settings/roles", labelKey: "nav.settingsRoles" },
];

/** A screen, and the capability that decides it. */
export interface PreviewScreenVerdict extends PreviewScreen {
  /** Null when any signed-in seat may open it. */
  readonly capability: Capability | null;
}

/** One permission area, split into what the role holds and what it does not. */
export interface PreviewGroup {
  readonly key: string;
  readonly labelKey: string;
  readonly allowed: Capability[];
  readonly denied: Capability[];
  /** The verbs this area actually uses — its columns in the action matrix. */
  readonly actions: PermissionAction[];
}

export interface AccessPreview {
  /** The effective list, after the overlay and the exceptions. */
  readonly capabilities: Capability[];
  /** What the role gave, before exceptions — so a delta can be shown. */
  readonly roleCapabilities: Capability[];
  readonly screens: { readonly visible: PreviewScreenVerdict[]; readonly hidden: PreviewScreenVerdict[] };
  readonly groups: PreviewGroup[];
  /** Capabilities the role would have held and the exceptions took away. */
  readonly removedByException: Capability[];
  /** Capabilities the exceptions added on top of the role. */
  readonly addedByException: Capability[];
}

export interface AccessPreviewInput {
  role: AppRole | string | null | undefined;
  /** The overlay being previewed, when one is assigned or being drafted. */
  customRole?: { capabilities: readonly string[]; active: boolean } | null;
  exceptions?: CapabilityExceptions | null;
}

/** Every screen with the capability that opens it, resolved once. */
export function previewScreens(): PreviewScreenVerdict[] {
  return PREVIEW_SCREENS.map((screen) => ({ ...screen, capability: capabilityForPath(screen.path) }));
}

/**
 * Answer the question. Pure: the same inputs always give the same preview, in
 * either mode, whether or not anybody is signed in.
 */
export function previewAccess({ role, customRole, exceptions }: AccessPreviewInput): AccessPreview {
  const roleCapabilities = resolveCapabilities(role, customRole ?? null);
  const capabilities = applyExceptions(roleCapabilities, exceptions);
  const held = new Set(capabilities);

  const screens = previewScreens();
  const visible = screens.filter((screen) => !screen.capability || held.has(screen.capability));
  const hidden = screens.filter((screen) => screen.capability && !held.has(screen.capability));

  const groups: PreviewGroup[] = CAPABILITY_GROUPS.map((group) => ({
    key: group.key,
    labelKey: capabilityGroupLabelKey(group.key),
    allowed: group.capabilities.filter((capability) => held.has(capability)),
    denied: group.capabilities.filter((capability) => !held.has(capability)),
    actions: actionsInGroup(group.key),
  }));

  const roleSet = new Set(roleCapabilities);
  return {
    capabilities,
    roleCapabilities,
    screens: { visible, hidden },
    groups,
    removedByException: CAPABILITIES.filter(
      (capability) => roleSet.has(capability) && !held.has(capability),
    ),
    addedByException: CAPABILITIES.filter(
      (capability) => !roleSet.has(capability) && held.has(capability),
    ),
  };
}

/**
 * The same preview for a system role with no overlay — what the Roles screen
 * offers when an admin wants to know what "Cashier" means before building
 * anything on top of it.
 */
export function previewSystemRole(role: AppRole, exceptions?: CapabilityExceptions | null): AccessPreview {
  return previewAccess({ role, customRole: null, exceptions });
}

/** How many acts a role holds, by verb — the summary line on a role card. */
export function actionTally(
  capabilities: readonly Capability[],
): Array<{ action: PermissionAction; count: number }> {
  const counts = new Map<PermissionAction, number>();
  for (const capability of capabilities) {
    const action = actionOfCapability(capability);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  // Declaration order of the verbs, not insertion order: two roles with the same
  // tally read the same way.
  return PERMISSION_ACTIONS.filter((action) => counts.has(action)).map((action) => ({
    action,
    count: counts.get(action) as number,
  }));
}
