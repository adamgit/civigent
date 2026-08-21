interface SegmentedOption {
  value: string;
  label: string;
}

interface SegmentedControlProps {
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  tone?: "human" | "agent";
  label: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  tone = "human",
  label,
}: SegmentedControlProps) {
  return (
    <div className="segmented" data-tone={tone} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__option"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
