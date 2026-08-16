const FALLBACK_TITLE = "Civigent";

/**
 * Human-facing home title. `KS_APP_NAME` is the install label; when unset the
 * session falls back to the public URL, which is a hostname not a name.
 */
export function homeInstallTitle(appName: string): string {
  const trimmed = appName.trim();
  if (!trimmed) return FALLBACK_TITLE;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return FALLBACK_TITLE;
    }
  } catch {
    /* not a URL — treat as an explicit install name */
  }
  return trimmed;
}

export function homeHostLabel(): string {
  return window.location.host || "local";
}
