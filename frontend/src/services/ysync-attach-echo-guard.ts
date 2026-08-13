import type * as Y from "yjs";
import { proseMirrorNodeToMarkdown, type ProseMirrorNode } from "@ks/milkdown-serializer";
import { fragmentToMarkdown } from "./fragment-to-markdown";

interface YSyncBindingLike {
  _prosemirrorChanged: (doc: ProseMirrorNode) => void;
}

interface YSyncPluginStateLike {
  binding?: YSyncBindingLike | null;
}

export function installAttachEchoGuard(
  syncPluginState: unknown,
  ydoc: Y.Doc,
  fragmentKey: string,
): () => void {
  const binding = (syncPluginState as YSyncPluginStateLike | null | undefined)?.binding;
  if (!binding || typeof binding._prosemirrorChanged !== "function") {
    return () => {};
  }
  const original = binding._prosemirrorChanged.bind(binding);
  let disarmed = false;
  let lastSkippedDoc: ProseMirrorNode | null = null;

  binding._prosemirrorChanged = (doc: ProseMirrorNode): void => {
    if (!disarmed) {
      if (doc === lastSkippedDoc) return;
      let matches = false;
      try {
        const editorMarkdown = proseMirrorNodeToMarkdown(doc);
        const fragmentMarkdown = fragmentToMarkdown(ydoc, fragmentKey) ?? "";
        matches = editorMarkdown === fragmentMarkdown;
      } catch {
        matches = false;
      }
      if (matches) {
        lastSkippedDoc = doc;
        return;
      }
      disarmed = true;
    }
    original(doc);
  };

  return () => {
    disarmed = true;
  };
}
