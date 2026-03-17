const POSTURE_OPTIONS = ["yolo", "aggressive", "eager", "conservative"] as const;

interface SystemPostureBarProps {
  preset: string;
  summary: string;
}

export function SystemPostureBar({ preset, summary }: SystemPostureBarProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-row gap-1">
        {POSTURE_OPTIONS.map((option) => {
          const isActive = preset === option;
          return (
            <span
              key={option}
              className={
                isActive
                  ? "px-2 py-0.5 rounded text-[11px] font-semibold bg-accent text-white"
                  : "px-2 py-0.5 rounded text-[11px] font-medium text-gray-400 bg-gray-100"
              }
            >
              {option}
            </span>
          );
        })}
      </div>
      {summary && (
        <p className="text-[10px] text-gray-500 leading-snug">{summary}</p>
      )}
    </div>
  );
}
