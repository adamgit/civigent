import type { ReactNode } from "react";

type StatusPillVariant = "green" | "yellow" | "red" | "agent" | "muted" | "accent";

const variantClass: Record<StatusPillVariant, string> = {
  green: "bg-status-green-light text-status-green",
  yellow: "bg-status-yellow-light text-status-yellow",
  red: "bg-status-red-light text-status-red",
  agent: "bg-agent-light text-agent-text",
  muted: "bg-footer-bg text-text-muted",
  accent: "bg-accent-light text-accent-text",
};

const dotClass: Record<StatusPillVariant, string> = {
  green: "bg-status-green",
  yellow: "bg-status-yellow",
  red: "bg-status-red",
  agent: "bg-agent",
  muted: "bg-text-muted",
  accent: "bg-accent-text",
};

interface StatusPillProps {
  variant: StatusPillVariant;
  children: ReactNode;
  showDot?: boolean;
}

export function StatusPill({ variant, children, showDot = false }: StatusPillProps) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-[10px] ${variantClass[variant]}`}>
      {showDot && (
        <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${dotClass[variant]}`} />
      )}
      {children}
    </span>
  );
}
