const USER_EDIT_HISTORY_STORAGE_KEY = "ks_last_human_edits";
const USER_EDIT_SNAPSHOTS_STORAGE_KEY = "ks_last_human_snapshots";

type LastHumanEditMap = Record<string, string>;
interface LastHumanSnapshotEntry {
  editedAt: string;
  content: string;
}
type LastHumanSnapshotMap = Record<string, LastHumanSnapshotEntry>;

function readHistory(): LastHumanEditMap {
  try {
    const raw = localStorage.getItem(USER_EDIT_HISTORY_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: LastHumanEditMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === "string" && typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeHistory(history: LastHumanEditMap): void {
  try {
    localStorage.setItem(USER_EDIT_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Ignore storage write failures in constrained environments.
  }
}

function readSnapshots(): LastHumanSnapshotMap {
  try {
    const raw = localStorage.getItem(USER_EDIT_SNAPSHOTS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: LastHumanSnapshotMap = {};
    for (const [docPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof docPath === "string"
        && value
        && typeof value === "object"
        && typeof (value as { editedAt?: unknown }).editedAt === "string"
        && typeof (value as { content?: unknown }).content === "string"
      ) {
        out[docPath] = {
          editedAt: (value as { editedAt: string }).editedAt,
          content: (value as { content: string }).content,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeSnapshots(history: LastHumanSnapshotMap): void {
  try {
    localStorage.setItem(USER_EDIT_SNAPSHOTS_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Ignore storage write failures in constrained environments.
  }
}

export function getLastHumanEditAt(docPath: string): string | null {
  const value = readHistory()[docPath];
  return value ?? null;
}

export function getAllLastHumanEdits(): Record<string, string> {
  return readHistory();
}

export function getLastHumanSnapshot(docPath: string): LastHumanSnapshotEntry | null {
  const value = readSnapshots()[docPath];
  return value ?? null;
}

export function rememberHumanSnapshot(docPath: string, content: string, editedAt?: string): void {
  if (!docPath.trim()) {
    return;
  }
  const history = readSnapshots();
  history[docPath] = {
    editedAt: editedAt ?? new Date().toISOString(),
    content,
  };
  writeSnapshots(history);
}

export function markHumanEditedNow(docPath: string, content?: string): void {
  const editedAt = new Date().toISOString();
  const history = readHistory();
  history[docPath] = editedAt;
  writeHistory(history);
  if (typeof content === "string") {
    rememberHumanSnapshot(docPath, content, editedAt);
  }
}
