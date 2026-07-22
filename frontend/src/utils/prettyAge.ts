/**
 * Convert a server-provided seconds_ago value to a human-readable string.
 * Examples: "just now", "3 min ago", "2h ago", "4d ago"
 *
 * This is a FRESHNESS value, never a liveness claim: a small age must not read
 * as "editing now" (a static, recently-saved section is not being edited). The
 * live "Editing now" label is owned by the section-attribution FSM's
 * `liveEditing` state, driven by awareness presence, not by this age.
 */
export function prettyAge(secondsAgo: number): string {
  if (secondsAgo < 60) return "just now";
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)} min ago`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  return `${Math.floor(secondsAgo / 86400)}d ago`;
}
