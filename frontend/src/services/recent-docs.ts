const RECENT_DOCS_STORAGE_KEY = "ks_recent_docs";
const MAX_RECENT_DOCS = 40;

function readRecentDocsRaw(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_DOCS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  } catch {
    return [];
  }
}

function writeRecentDocsRaw(values: string[]): void {
  try {
    localStorage.setItem(RECENT_DOCS_STORAGE_KEY, JSON.stringify(values.slice(0, MAX_RECENT_DOCS)));
  } catch {
    // Ignore storage write failures in constrained environments.
  }
}

export function listRecentDocs(): string[] {
  return readRecentDocsRaw();
}

export function rememberRecentDoc(docPath: string): void {
  const normalized = docPath.trim();
  if (!normalized) {
    return;
  }
  const current = readRecentDocsRaw();
  const deduped = [normalized, ...current.filter((entry) => entry !== normalized)];
  writeRecentDocsRaw(deduped);
}
