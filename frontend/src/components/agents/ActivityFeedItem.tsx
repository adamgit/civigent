import type { ActivityFeedEvent } from "./types.js";
import { formatRelativeTime } from "./utils.js";

interface ActivityFeedItemProps {
  event: ActivityFeedEvent;
}

export function ActivityFeedItem({ event }: ActivityFeedItemProps) {
  const { agentDisplayName, agentAvatarLetter, agentAvatarHue, action, targetDescription, timestamp, documentPreview } = event;

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-gray-50 transition-colors">
      {/* Agent avatar (20px circle) */}
      <div
        className="flex items-center justify-center rounded-full text-white text-[9px] font-bold shrink-0 mt-0.5"
        style={{
          width: 20,
          height: 20,
          background: `hsl(${agentAvatarHue}, 65%, 48%)`,
        }}
      >
        {agentAvatarLetter}
      </div>

      {/* Content */}
      <div className="flex flex-col min-w-0 flex-1">
        <p className="text-xs text-gray-700 m-0 leading-snug">
          <span className="font-semibold">{agentDisplayName}</span>
          {" "}
          <span className="text-gray-600">{action}</span>
          {" "}
          <span className="text-gray-700">{targetDescription}</span>
        </p>
        {documentPreview ? (
          <p className="text-[10px] text-gray-400 mt-0.5 m-0 truncate">{documentPreview}</p>
        ) : null}
      </div>

      {/* Timestamp */}
      <span className="text-[10px] text-gray-400 shrink-0 mt-0.5">
        {formatRelativeTime(timestamp)}
      </span>
    </div>
  );
}
