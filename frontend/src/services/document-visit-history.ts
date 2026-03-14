const DOC_LAST_VISIT_STORAGE_KEY = "ks_doc_last_visit_at";

type LastVisitMap = Record<string, string>;

function readLastVisitMap(): LastVisitMap {
  try {
    const raw = localStorage.getItem(DOC_LAST_VISIT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: LastVisitMap = {};
    for (const [docPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof docPath === "string" && typeof value === "string") {
        out[docPath] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeLastVisitMap(next: LastVisitMap): void {
  try {
    localStorage.setItem(DOC_LAST_VISIT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage write failures in constrained environments.
  }
}

export function getLastDocumentVisitAt(docPath: string): string | null {
  const normalized = docPath.trim();
  if (!normalized) {
    return null;
  }
  return readLastVisitMap()[normalized] ?? null;
}

export function markDocumentVisitedNow(docPath: string): void {
  const normalized = docPath.trim();
  if (!normalized) {
    return;
  }
  const visits = readLastVisitMap();
  visits[normalized] = new Date().toISOString();
  writeLastVisitMap(visits);
}
