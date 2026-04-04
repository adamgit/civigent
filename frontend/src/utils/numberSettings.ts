export function readNumberSetting(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  } catch {
    return fallback;
  }
}

export function writeNumberSetting(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.max(1, Math.floor(value))));
  } catch {}
}
