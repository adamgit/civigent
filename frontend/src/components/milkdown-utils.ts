/**
 * Utility functions for the Milkdown rich editor adapter.
 *
 * - normalizeMarkdown: round-trips markdown through the shared serializer
 *   to guarantee byte-identical output with the server.
 * - resolveHeadingPathFromDoc: resolves the heading path at a given
 *   ProseMirror document position (mirrors resolveHeadingPathAtCursor
 *   from DocumentEditPage but operates on PM nodes).
 */

import {
  markdownToProseMirrorNode,
  proseMirrorNodeToMarkdown,
  type ProseMirrorNode,
} from "@ks/milkdown-serializer";

/**
 * Normalize markdown by round-tripping through the shared serializer.
 * Guarantees output is identical to what the server would produce.
 */
export function normalizeMarkdown(md: string): string {
  return proseMirrorNodeToMarkdown(markdownToProseMirrorNode(md));
}

/**
 * Resolve the heading path at a given position within a ProseMirror document.
 *
 * Walks top-level nodes sequentially, maintaining a heading stack identical
 * to the logic in `resolveHeadingPathAtCursor` (which operates on raw
 * markdown lines). When the cumulative position passes `pos`, the current
 * stack is returned.
 *
 * @param doc  ProseMirror document node
 * @param pos  Anchor position from the selection (selection.$anchor.pos)
 * @returns    Heading path as string[] (e.g. ["Section", "Subsection"])
 */
export function resolveHeadingPathFromDoc(
  doc: ProseMirrorNode,
  pos: number,
): string[] {
  const stack: string[] = [];
  // offset tracks the position boundary between top-level nodes.
  // In ProseMirror, doc content starts at position 1 (position 0 is
  // before the doc node's opening tag).
  let offset = 0;

  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    // Each top-level node occupies child.nodeSize positions
    // (including its opening/closing tokens).
    const nodeStart = offset;
    const nodeEnd = offset + child.nodeSize;

    if (child.type.name === "heading") {
      const level: number =
        typeof child.attrs.level === "number" ? child.attrs.level : 1;
      const text = child.textContent.trim();
      // Truncate stack to current depth and set this level.
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = text;
    }

    // If the position falls within (or before) this node, return current path.
    if (pos <= nodeEnd) {
      return stack.slice();
    }

    offset = nodeEnd;
  }

  return stack.slice();
}
