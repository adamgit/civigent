const FALLBACK_TITLE = "Civigent";
const DEFAULT_TAGLINE = "A working wiki — written by people, kept tidy by agents.";

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

/** Split `collab.example.com` so the subdomain can render in a lighter weight. */
export function splitHomeHost(host: string): { subdomain?: string; rest: string } {
  const hostname = host.split(":")[0] ?? host;
  const parts = hostname.split(".");
  if (parts.length < 3) return { rest: host };
  const port = host.includes(":") ? host.slice(host.indexOf(":")) : "";
  return { subdomain: parts[0], rest: `${parts.slice(1).join(".")}${port}` };
}

export function homePageTagline(appName: string): string {
  const name = homeInstallTitle(appName);
  const host = homeHostLabel();
  if (name !== FALLBACK_TITLE && name !== host) {
    return `${name} — written by people, kept tidy by agents.`;
  }
  return DEFAULT_TAGLINE;
}
