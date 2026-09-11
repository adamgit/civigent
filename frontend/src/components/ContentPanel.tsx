import type { ReactNode } from "react";

function Header({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between px-4 py-3 border-b border-footer-bg ${className}`}>
      {children}
    </div>
  );
}

function Title({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[13px] font-semibold text-text-primary">
      {icon}
      {children}
    </div>
  );
}

function Subtitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] text-text-muted mt-0.5">
      {children}
    </div>
  );
}

function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={className.includes("p-0") || className.includes("padding") ? className : `px-4 py-3.5 ${className}`}>
      {children}
    </div>
  );
}

function Summary({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-2.5 border-t border-footer-bg bg-section-hover text-[11px] text-text-muted">
      {children}
    </div>
  );
}

export function ContentPanel({ children }: { children: ReactNode }) {
  return (
    <div className="bg-canvas-bg border border-card-border rounded-[10px] mb-4 overflow-hidden">
      {children}
    </div>
  );
}

ContentPanel.Header = Header;
ContentPanel.Title = Title;
ContentPanel.Subtitle = Subtitle;
ContentPanel.Body = Body;
ContentPanel.Summary = Summary;
