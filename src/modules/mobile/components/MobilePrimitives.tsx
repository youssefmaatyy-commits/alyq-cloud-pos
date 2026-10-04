import type { ReactNode } from "react";

export function MobilePage({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="mobile-page" data-mobile-page>
    <header className="mobile-page-header">
      <div><h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div>
      {actions ? <div className="mobile-page-actions">{actions}</div> : null}
    </header>
    {children}
  </section>;
}

export function MobileCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mobile-card ${className}`}>{children}</div>;
}

export function MobileState({ kind, title, detail, retry }: { kind: "loading" | "empty" | "error" | "denied" | "offline"; title: string; detail?: string; retry?: () => void }) {
  return <div className={`mobile-state mobile-state-${kind}`} role={kind === "error" ? "alert" : "status"}>
    <strong>{title}</strong>{detail ? <p>{detail}</p> : null}
    {retry ? <button type="button" onClick={retry}>Retry</button> : null}
  </div>;
}

export function MobileBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "info" }) {
  return <span className={`mobile-badge mobile-badge-${tone}`}>{children}</span>;
}
