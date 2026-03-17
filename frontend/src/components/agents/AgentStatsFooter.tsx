interface StatItem {
  label: string;
  value: string | number;
}

interface AgentStatsFooterProps {
  stats: StatItem[];
}

export function AgentStatsFooter({ stats }: AgentStatsFooterProps) {
  return (
    <div className="flex flex-row flex-wrap gap-x-4 gap-y-1 pt-2 mt-2 border-t border-gray-200">
      {stats.map((stat) => (
        <div key={stat.label} className="flex flex-col items-center">
          <span className="text-xs font-semibold text-gray-700">{stat.value}</span>
          <span className="text-[10px] text-gray-400 uppercase tracking-wide">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}
