interface WriterIdentityProps {
  name: string;
  kind: "human" | "agent";
}

export function WriterIdentity({ name, kind }: WriterIdentityProps) {
  const isAgent = kind === "agent";
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          fontSize: 9,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: isAgent ? "#f3effa" : "#e8f4f6",
          color: isAgent ? "#6b4fa0" : "#1d5a66",
          flexShrink: 0,
        }}
      >
        {name.slice(0, 2).toUpperCase()}
      </span>
      <span style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{name}</span>
    </span>
  );
}
