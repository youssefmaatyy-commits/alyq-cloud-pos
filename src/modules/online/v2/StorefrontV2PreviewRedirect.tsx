import { Navigate, useLocation } from "react-router-dom";
import { canonicalPreviewSearch, canonicalStorePathname } from "./storeRoutes";

/** Old bookmarks resolve in place without mounting a second page tree.
 * Preserve only consumed, safe query keys (especially NOT tracking phones) and
 * same-tab state. Replace avoids a back-loop; old fragment data is dropped. */
export function StorefrontV2PreviewRedirect() {
  const { pathname, search, state } = useLocation();
  return <Navigate to={{ pathname: canonicalStorePathname(pathname),
    search: canonicalPreviewSearch(pathname, search) }} state={state} replace />;
}
