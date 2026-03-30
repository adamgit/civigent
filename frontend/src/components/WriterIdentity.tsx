import type { AttributionWriterType } from "../types/shared.js";

interface WriterIdentityProps {
  name: string;
  kind: AttributionWriterType;
  rawKind?: string;
}

export function WriterIdentity({ name, kind, rawKind }: WriterIdentityProps) {
  const isAgent = kind === "agent";
  const isHuman = kind === "human";
  const isUnknown = !isAgent && !isHuman;
  const raw = rawKind ?? "(missing)";
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
          background: isUnknown ? "transparent" : isAgent ? "#f3effa" : "#e8f4f6",
          color: isUnknown ? "var(--color-error)" : isAgent ? "#6b4fa0" : "#1d5a66",
          flexShrink: 0,
        }}
        title={isUnknown ? `Raw backend writer type: ${raw}` : undefined}
      >
        {name.slice(0, 2).toUpperCase()}
      </span>
      <span
        className={isUnknown ? "text-error" : ""}
        style={{ fontWeight: 500, color: isUnknown ? "var(--color-error)" : "var(--color-text-primary)" }}
      >
        {name}
      </span>
      {isUnknown ? (
        <span className="text-[10px] text-error cursor-help" title={`Raw backend writer type: ${raw}`} tabIndex={0}>
          UNKNOWN
        </span>
      ) : null}
    </span>
  );
}
