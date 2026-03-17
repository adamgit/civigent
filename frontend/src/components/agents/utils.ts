export function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  if (isNaN(diffMs)) return iso;

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return diffSec <= 1 ? "just now" : `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export function avatarHueFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

export function acceptanceRate(accepted: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((accepted / total) * 100);
}
