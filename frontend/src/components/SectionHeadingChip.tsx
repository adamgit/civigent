interface SectionHeadingChipProps {
  children: string;
}

export function SectionHeadingChip({ children }: SectionHeadingChipProps) {
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', var(--font-mono, monospace)",
        fontSize: 11,
        color: "var(--color-text-muted)",
        background: "#f7f5f1",
        padding: "2px 6px",
        borderRadius: 3,
        display: "inline",
      }}
    >
      {children}
    </span>
  );
}
