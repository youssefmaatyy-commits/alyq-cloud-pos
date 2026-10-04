import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useBranch } from "@/lib/branch";
import { useRealtimeStatus } from "@/lib/supabase/useRealtimeWatch";
import { probeSystemBackend, type BackendHealthProbe } from "@/modules/system/services/healthService";
import { MobileBadge, MobileCard, MobilePage, MobileState } from "../components/MobilePrimitives";
import { useMobile } from "../MobileContext";

function tone(value: boolean | null | undefined): "success" | "warning" | "neutral" { return value === true ? "success" : value === false ? "warning" : "neutral"; }

export function MobileHealthPage() {
  const auth = useAuth();
  const branch = useBranch();
  const realtime = useRealtimeStatus();
  const mobile = useMobile();
  const [probe, setProbe] = useState<BackendHealthProbe | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    setLoading(true);
    try { await mobile.refreshNetwork(); setProbe(await probeSystemBackend()); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [branch.current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <MobilePage title="Mobile Health" subtitle="Existing ALYQ health contract" actions={<button type="button" className="mobile-action" onClick={() => void refresh()}>Refresh</button>}>
    {loading && !probe ? <MobileState kind="loading" title="Checking status…" /> : null}
    <MobileCard className="mobile-health-list">
      <div><span>ALYQ Mobile</span><strong>{mobile.runtime?.appVersion ?? "—"}</strong></div>
      <div><span>Build</span><strong>{mobile.runtime?.build ?? "—"}</strong></div>
      <div><span>Platform</span><strong>{mobile.runtime?.platform ?? "web"}</strong></div>
      <div><span>Network</span><MobileBadge tone={mobile.network === "online" ? "success" : mobile.network === "offline" ? "warning" : "neutral"}>{mobile.network}</MobileBadge></div>
      <div><span>Backend</span><MobileBadge tone={tone(probe?.reachable)}>{probe?.reachable ? `Healthy · ${probe.latencyMs ?? "—"}ms` : probe ? "Unavailable" : "Unknown"}</MobileBadge></div>
      <div><span>Authentication</span><MobileBadge tone={tone(auth.status === "authenticated" && probe?.authenticated !== false)}>{auth.status}</MobileBadge></div>
      <div><span>Realtime</span><MobileBadge tone={realtime === "live" ? "success" : realtime === "error" ? "warning" : "neutral"}>{realtime}</MobileBadge></div>
      <div><span>Active branch</span><MobileBadge tone={tone(Boolean(branch.current) && probe?.branchContextValid !== false)}>{branch.current?.code ?? "Unavailable"}</MobileBadge></div>
      <div><span>Schema</span><MobileBadge tone={probe?.schemaStatus === "compatible" ? "success" : probe?.schemaStatus === "mismatch" ? "warning" : "neutral"}>{probe?.schemaStatus ?? "unknown"}</MobileBadge></div>
      <div><span>Notifications</span><MobileBadge tone={mobile.pushState === "registered" ? "success" : mobile.pushState === "error" ? "warning" : "neutral"}>{mobile.pushState}</MobileBadge></div>
    </MobileCard>
    {probe?.safeError ? <MobileState kind="error" title="Health warning" detail={probe.safeError} /> : null}
    <p className="mobile-privacy-note">Health reports factual application state only. Provider delivery, lock-screen display, and physical network quality remain unknown unless verified by their platform.</p>
  </MobilePage>;
}
