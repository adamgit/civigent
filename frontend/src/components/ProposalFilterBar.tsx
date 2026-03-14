import type { ReactNode } from "react";

function Group({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        background: "#f7f5f1",
        borderRadius: 6,
        padding: 2,
      }}
    >
      {children}
    </div>
  );
}

function Option({
  children,
  active = false,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: "4px 10px",
        borderRadius: 4,
        background: active ? "white" : "none",
        color: active ? "var(--color-text-primary)" : "var(--color-text-muted)",
        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
        border: "none",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function SearchField({
  placeholder = "Search...",
  value,
  onChange,
}: {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        fontSize: 12,
        padding: "5px 10px",
        border: "1px solid #eae7e2",
        borderRadius: 5,
        width: 180,
        marginLeft: "auto",
        outline: "none",
      }}
    />
  );
}

export function ProposalFilterBar({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 16,
        flexWrap: "wrap",
      }}
    >
      {children}
    </div>
  );
}

ProposalFilterBar.Group = Group;
ProposalFilterBar.Option = Option;
ProposalFilterBar.SearchField = SearchField;
