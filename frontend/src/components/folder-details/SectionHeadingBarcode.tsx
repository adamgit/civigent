const BAR_HEIGHT_BY_LEVEL = [14, 12, 10, 8, 6, 4] as const;

function normalizedHeadingLevel(level: number): number {
  return Math.min(6, Math.max(1, Math.round(level)));
}

export function SectionHeadingBarcode({ levels }: { levels: readonly number[] }) {
  if (levels.length === 0) return null;

  const normalizedLevels = levels.map(normalizedHeadingLevel);
  const label = `${levels.length} section heading${levels.length === 1 ? "" : "s"}: ${normalizedLevels
    .map((level) => `H${level}`)
    .join(", ")}`;

  return (
    <span
      className="flex h-4 min-w-0 max-w-full items-end justify-end gap-0.5 overflow-hidden"
      role="img"
      aria-label={label}
      title={label}
    >
      {normalizedLevels.map((level, index) => (
        <span
          key={`${index}-${level}`}
          className="w-1 shrink-0 rounded-[1px] bg-folder-link opacity-75"
          style={{ height: `${BAR_HEIGHT_BY_LEVEL[level - 1]}px` }}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
