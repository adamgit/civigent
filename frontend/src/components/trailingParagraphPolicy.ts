import type { Ctx } from "@milkdown/ctx";
import type { Node } from "@milkdown/prose/model";
import { trailingConfig } from "@milkdown/plugin-trailing";

/**
 * Crepe always installs @milkdown/plugin-trailing. That plugin appends an
 * empty paragraph whenever the editor's last block is not a heading or a
 * paragraph, so a caret has a text block to sit in. Each section is its own
 * editor, so the extra paragraph shows up as a blank line at the end of the
 * section.
 *
 * Keep the paragraph only where Return cannot leave the block:
 *
 * - code_block: the node is code, so Return inserts a newline inside it.
 *   Leaving is Mod-Return, which creates the following paragraph at that moment.
 * - hr: a leaf. There is no caret inside it. Return creates a following
 *   paragraph only when the rule itself is the selection.
 *
 * Everywhere else, Return already leaves the block, and that exit creates
 * the paragraph. A second Return lifts an empty item out of a bullet list,
 * numbered list, blockquote, or footnote definition. Return in a table runs
 * the table exit command, which inserts a paragraph after the table.
 * Heading and paragraph are text blocks, so the caret is already inside them.
 */
const BLOCKS_RETURN_CANNOT_LEAVE = new Set(["code_block", "hr"]);

function sectionNeedsTrailingParagraph(lastNode: Node | null): boolean {
  return lastNode != null && BLOCKS_RETURN_CANNOT_LEAVE.has(lastNode.type.name);
}

export function trailingParagraphPolicy(ctx: Ctx): void {
  ctx.update(trailingConfig.key, (prev) => ({
    ...prev,
    shouldAppend: sectionNeedsTrailingParagraph,
  }));
}
