/**
 * Convert an ISO timestamp string or epoch-ms number to a human-readable
 * relative time string (e.g. "3s ago", "12m ago", "5h ago", "2d ago").
 */
export function relativeTime(timestamp: string | number): string {
  const ms = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp;
  const diff = Date.now() - ms;
  const seconds = Math.max(0, Math.floor(diff / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
