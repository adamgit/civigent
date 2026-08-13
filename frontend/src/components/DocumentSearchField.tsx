interface DocumentSearchFieldProps {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function DocumentSearchField({
  placeholder = "Search...",
  value,
  onChange,
  className,
}: DocumentSearchFieldProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      autoComplete="off"
      spellCheck={false}
      className={`min-w-0 border-0 border-b border-folder-card-border bg-transparent px-0 py-0.5 font-ui text-[12px] text-text-primary outline-none placeholder:text-text-faint focus:border-text-muted ${className ?? "w-full"}`}
    />
  );
}
