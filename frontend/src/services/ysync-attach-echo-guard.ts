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
  let lastSkipped: ProseMirrorNode | undefined;

  binding._prosemirrorChanged = (doc: ProseMirrorNode): void => {
    if (disarmed) {
      original(doc);
      return;
    }
    if (doc === lastSkipped) return;
    let unchanged = false;
    try {
      unchanged =
        proseMirrorNodeToMarkdown(doc) === (fragmentToMarkdown(ydoc, fragmentKey) ?? "");
    } catch {
      disarmed = true;
      original(doc);
      return;
    }
    if (unchanged) {
      lastSkipped = doc;
      return;
    }
    disarmed = true;
    original(doc);
  };

  return () => {
    disarmed = true;
  };
}
