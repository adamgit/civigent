import type { ReactNode } from "react";

function Group({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-0.5 bg-footer-bg rounded-md p-0.5">
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
      type="button"
      onClick={onClick}
      className={`text-[11px] font-medium px-2.5 py-1 rounded border-none cursor-pointer ${
        active
          ? "bg-canvas-bg text-text-primary shadow-sm"
          : "bg-transparent text-text-muted"
      }`}
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
      className="input-field text-xs w-[180px] ml-auto"
    />
  );
}

export function ProposalFilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      {children}
    </div>
  );
}

ProposalFilterBar.Group = Group;
ProposalFilterBar.Option = Option;
ProposalFilterBar.SearchField = SearchField;
