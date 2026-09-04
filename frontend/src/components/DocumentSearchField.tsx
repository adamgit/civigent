interface DocumentSearchFieldProps {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-text-muted">
      <circle cx="10.5" cy="10.5" r="6.25" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.2 15.2L20 20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function DocumentSearchField({
  placeholder = "Search...",
  value,
  onChange,
  className,
}: DocumentSearchFieldProps) {
  return (
    <label
      className={`flex min-w-0 items-center gap-2 rounded-md border border-folder-card-border bg-canvas-bg px-2.5 py-1.5 font-ui focus-within:border-accent-border ${className ?? "w-full"}`}
    >
      <SearchGlyph />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-text-primary outline-none placeholder:text-text-muted"
      />
    </label>
  );
}
