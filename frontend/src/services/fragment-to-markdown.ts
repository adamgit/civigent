/**
 * Convert a Y.Doc XmlFragment to markdown string.
 *
 * Uses the same pipeline as the backend's FragmentStore:
 *   XmlFragment → ProseMirror JSON → markdown
 */

import type * as Y from "yjs";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { jsonToMarkdown } from "@ks/milkdown-serializer";

export function fragmentToMarkdown(ydoc: Y.Doc, fragmentKey: string): string {
  const pmJson = yDocToProsemirrorJSON(ydoc, fragmentKey) as Record<string, unknown>;
  return jsonToMarkdown(pmJson);
}
