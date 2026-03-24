/**
 * Convert a server-provided seconds_ago value to a human-readable string.
 * Examples: "editing now", "3 min ago", "2h ago", "4d ago"
 */
export function prettyAge(secondsAgo: number): string {
  if (secondsAgo < 60) return "editing now";
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)} min ago`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  return `${Math.floor(secondsAgo / 86400)}d ago`;
}
