interface MiniDocPreviewProps {
  docPath: string;
  displayName: string;
  sectionDiffs: string[];
}

export function MiniDocPreview({ displayName, sectionDiffs }: MiniDocPreviewProps) {
  return (
    <div className="inline-flex flex-col gap-0.5 bg-slate-100 rounded px-2 py-1">
      <span className="text-[10px] text-slate-600 font-medium truncate max-w-[120px]">
        {displayName}
      </span>
      <div className="flex flex-col gap-px">
        {sectionDiffs.map((diff, i) => (
          <div
            key={i}
            title={diff}
            style={{
              height: 2,
              borderRadius: 1,
              backgroundColor: i % 2 === 0 ? "#4ade80" : "#fbbf24",
              width: "100%",
              minWidth: 24,
            }}
          />
        ))}
      </div>
    </div>
  );
}
