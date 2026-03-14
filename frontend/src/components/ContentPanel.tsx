import type { ReactNode } from "react";

function Header({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex items-center justify-between ${className}`}
      style={{ padding: "12px 16px", borderBottom: "1px solid #f0ede8" }}
    >
      {children}
    </div>
  );
}

function Title({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>
      {icon}
      {children}
    </div>
  );
}

function Subtitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
      {children}
    </div>
  );
}

function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={className} style={{ padding: className.includes("p-0") || className.includes("padding") ? undefined : "14px 16px" }}>
      {children}
    </div>
  );
}

function Summary({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 16px",
        borderTop: "1px solid #f0ede8",
        background: "var(--color-section-hover, #faf8f5)",
        fontSize: 11,
        color: "var(--color-text-muted)",
      }}
    >
      {children}
    </div>
  );
}

export function ContentPanel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: "white",
        border: "1px solid var(--color-card-border, #eae7e2)",
        borderRadius: "var(--color-card-radius, 10px)",
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

ContentPanel.Header = Header;
ContentPanel.Title = Title;
ContentPanel.Subtitle = Subtitle;
ContentPanel.Body = Body;
ContentPanel.Summary = Summary;
