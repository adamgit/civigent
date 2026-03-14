import type { ReactNode } from "react";

type StatusPillVariant = "green" | "yellow" | "red" | "agent" | "muted" | "accent";

const variantStyles: Record<StatusPillVariant, { bg: string; text: string; dot: string }> = {
  green: { bg: "#e8f5ed", text: "#3a9a5c", dot: "#3a9a5c" },
  yellow: { bg: "#fdf6e4", text: "#8a6a10", dot: "#c49a2a" },
  red: { bg: "#fce8e6", text: "#c4493a", dot: "#c4493a" },
  agent: { bg: "#f3effa", text: "#6b4fa0", dot: "#8b6cc1" },
  muted: { bg: "#f7f5f1", text: "#8a8279", dot: "#8a8279" },
  accent: { bg: "#e8f4f6", text: "#1d5a66", dot: "#1d5a66" },
};

interface StatusPillProps {
  variant: StatusPillVariant;
  children: ReactNode;
  showDot?: boolean;
}

export function StatusPill({ variant, children, showDot = false }: StatusPillProps) {
  const style = variantStyles[variant];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: "10.5px",
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 10,
        background: style.bg,
        color: style.text,
      }}
    >
      {showDot && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: style.dot,
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </span>
  );
}
