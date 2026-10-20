import { Link } from "react-router-dom";
import { can } from "@/lib/permissions/enforce";
import { MobileCard, MobilePage } from "../components/MobilePrimitives";
import { useMobile } from "../MobileContext";

export function MobileMorePage() {
  const mobile = useMobile();
  const links = [
    can("pos.sell") ? ["POS Register (Cashier)", "/dashboard/pos"] : null,
    ["Full ALYQ POS Workspace", "/dashboard"],
    can("sales.view") ? ["Invoices & returns", "/mobile/invoices"] : null,
    can("approvals.approve") ? ["Approval Center", "/mobile/approvals"] : null,
    can("products.view") ? ["Products", "/mobile/inventory"] : null,
    can("system.health_check") ? ["Mobile Health", "/mobile/health"] : null,
  ].filter(Boolean) as string[][];
  return <MobilePage title="More" subtitle="Management tools">
    <MobileCard className="mobile-more-list">{links.map(([label, href]) => <Link key={href} to={href}><span>{label}</span><span>›</span></Link>)}</MobileCard>
    <MobileCard><strong>ALYQ POS Mobile</strong><p>Version {mobile.runtime?.appVersion ?? "—"}</p><p className="mobile-muted">Build {mobile.runtime?.build ?? "—"} · {mobile.runtime?.platform ?? "web"}</p></MobileCard>
  </MobilePage>;
}
