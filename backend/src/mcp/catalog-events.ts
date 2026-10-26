import type { DocPath, WsServerEvent } from "../types/shared.js";

export function emitDocRenamed(
  emitEvent: ((event: WsServerEvent) => void) | undefined,
  renamed: { oldPath: DocPath; newPath: DocPath },
  committedHead: string,
): void {
  if (!emitEvent) {
    return;
  }
  emitEvent({
    type: "doc:renamed",
    old_path: renamed.oldPath,
    new_path: renamed.newPath,
    committed_head: committedHead,
  });
}
