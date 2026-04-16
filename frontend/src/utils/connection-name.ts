const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const FALLBACK_NAME = "civigent";

function sanitizeLabel(label: string): string {
  return label
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function defaultConnectionName(mcpUrl: string): string {
  if (!mcpUrl) return FALLBACK_NAME;
  let parsed: URL;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return FALLBACK_NAME;
  }
  const rawHostname = parsed.hostname.toLowerCase();
  if (!rawHostname) return FALLBACK_NAME;
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;
  if (LOCAL_HOSTS.has(hostname)) return FALLBACK_NAME;

  const sanitized = hostname
    .split(".")
    .map(sanitizeLabel)
    .filter(Boolean)
    .join(".");
  return sanitized || FALLBACK_NAME;
}
