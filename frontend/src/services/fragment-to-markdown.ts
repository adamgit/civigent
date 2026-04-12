/**
 * Convert a Y.Doc XmlFragment to markdown string.
 *
 * Uses the same pipeline as the backend's LiveFragmentStringsStore:
 *   XmlFragment → ProseMirror JSON → markdown
 */

import type * as Y from "yjs";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { jsonToMarkdown } from "@ks/milkdown-serializer";

export function fragmentToMarkdown(ydoc: Y.Doc, fragmentKey: string): string | null {
  const pmJson = yDocToProsemirrorJSON(ydoc, fragmentKey) as { type: string; content?: unknown[] };
  if (!pmJson.content || pmJson.content.length === 0) return null;
  return jsonToMarkdown(pmJson as Record<string, unknown>);
}
