interface PageStatusBarProps {
  items: string[];
}

export function PageStatusBar({ items }: PageStatusBarProps) {
  return (
    <div
      style={{
        height: 26,
        minHeight: 26,
        background: "#f0ede8",
        borderTop: "1px solid #e2ded8",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "10.5px",
        color: "#a09888",
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        gap: 4,
      }}
    >
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span style={{ margin: "0 6px", color: "#d0ccc4" }}>&middot;</span>}
          {item}
        </span>
      ))}
    </div>
  );
}
