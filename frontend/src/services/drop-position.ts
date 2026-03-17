/**
 * Drop-position utilities — convert PM/DOM coordinates to markdown offsets.
 *
 * Used by the drag/drop pipeline to determine where dropped content
 * should be inserted within the target section's markdown.
 */

import type { EditorView } from "@milkdown/prose/view";

/**
 * Convert a ProseMirror position to a character offset in the section's markdown.
 *
 * Walks the PM doc up to `pmPos`, counting block boundaries as paragraph
 * separators (\n\n). Provides block-level accuracy (between paragraphs/headings)
 * with best-effort character-level accuracy within text blocks.
 *
 * @param view The ProseMirror EditorView
 * @param pmPos The PM position from posAtCoords
 * @param markdown The section's current markdown string
 * @returns Character offset in the markdown string
 */
export function pmPosToMarkdownOffset(
  _view: EditorView,
  pmPos: number,
  markdown: string,
): number {
  // Split markdown into block-level chunks separated by blank lines
  const blocks = markdown.split(/\n\n/);
  if (blocks.length === 0) return 0;

  // ProseMirror doc structure: doc > (block nodes)+
  // Each block node has positions: [openTag, ...content..., closeTag]
  // Doc itself takes position 0, first block content starts at 1.
  // Between blocks: closeTag of prev + openTag of next = 2 positions.
  // So block i starts at: 1 + sum of (blockContentSize + 2) for all j < i
  // And block i's internal range is [start, start + contentSize]

  // We'll approximate: accumulate markdown offset as we pass through blocks.
  // Track running PM pos and markdown offset together.
  let mdOffset = 0;
  let runningPmPos = 1; // doc open tag = 0, first block content starts at 1

  for (let i = 0; i < blocks.length; i++) {
    const blockText = blocks[i];
    // Approximate block content size in PM as number of text characters + 1 (for the block node itself)
    const blockContentLen = blockText.length;

    if (pmPos <= runningPmPos + blockContentLen) {
      // Target is within this block
      const offsetInBlock = Math.max(0, pmPos - runningPmPos);
      return Math.min(mdOffset + offsetInBlock, markdown.length);
    }

    mdOffset += blockText.length + 2; // +2 for \n\n separator
    runningPmPos += blockContentLen + 2; // +2 for block open/close tags
  }

  return markdown.length;
}

/**
 * Convert a DOM caret position to a character offset in the section's markdown.
 *
 * Walks DOM nodes in document order, mapping block elements to markdown
 * block separators (\n\n). Provides block-level accuracy.
 *
 * @param container The section's DOM container element
 * @param range A Range from caretRangeFromPoint
 * @param markdown The section's current markdown string
 * @returns Character offset in the markdown string
 */
export function domPosToMarkdownOffset(
  container: HTMLElement,
  range: Range,
  markdown: string,
): number {
  const blocks = markdown.split(/\n\n/);
  if (blocks.length === 0) return 0;

  // Find which block-level child of the container the range falls in
  const blockElements = container.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, tr, blockquote");
  let blockIndex = 0;

  for (let i = 0; i < blockElements.length; i++) {
    const el = blockElements[i];
    if (el.contains(range.startContainer) || el === range.startContainer) {
      blockIndex = i;
      break;
    }
    // If the range is before this element, the previous block was the target
    const cmp = range.startContainer.compareDocumentPosition(el);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) {
      blockIndex = Math.max(0, i - 1);
      break;
    }
    blockIndex = i;
  }

  // Sum markdown offsets up to this block
  let mdOffset = 0;
  for (let i = 0; i < Math.min(blockIndex, blocks.length); i++) {
    mdOffset += blocks[i].length + 2; // +2 for \n\n
  }

  return Math.min(mdOffset, markdown.length);
}
