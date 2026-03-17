import { ActivityFeedItem } from "./ActivityFeedItem.js";
import type { ActivityFeedEvent } from "./types.js";

interface ActivityFeedProps {
  events: ActivityFeedEvent[];
}

export function ActivityFeed({ events }: ActivityFeedProps) {
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
        No recent agent activity
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-gray-100">
      {events.map((event) => (
        <ActivityFeedItem key={event.id} event={event} />
      ))}
    </div>
  );
}
