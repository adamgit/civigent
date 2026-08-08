const STORAGE_KEY_PREFIX = "civigent.lastDocSessionId:";

export function rememberDocSessionId(docPath: string, docSessionId: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY_PREFIX + docPath, docSessionId);
  } catch {
    return;
  }
}

export function recallDocSessionId(docPath: string): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY_PREFIX + docPath);
  } catch {
    return null;
  }
}
