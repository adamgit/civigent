/**
 * Relative timestamps for the home cards. Agent rows want a slightly longer
 * form ("4 minutes ago", "yesterday, 16:40"); document cards stay compact.
 */
export function formatHomeTime(timestamp: string, style: "long" | "compact" = "compact"): string {
  const then = new Date(timestamp);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return timestamp;

  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    if (style === "long") {
      return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
    }
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    if (style === "long") {
      return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
    }
    return `${hours}h ago`;
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (style === "long" && ms >= startOfYesterday.getTime() && ms < startOfToday.getTime()) {
    const clock = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    return `yesterday, ${clock}`;
  }

  const days = Math.floor(hours / 24);
  if (style === "compact") {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
