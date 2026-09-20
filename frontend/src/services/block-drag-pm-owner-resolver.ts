import type { Node as PmNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import {
  blockOwnerAddressesEqual,
  buildOwnerTree,
  type BlockOwnerAddress,
  type BlockOwnerKind,
  type BlockOwnerNode,
} from "./block-drag-model";

const PM_OWNER_KIND_BY_NODE_TYPE: Partial<Record<string, BlockOwnerKind>> = {
  heading: "heading",
  paragraph: "paragraph",
  bullet_list: "list",
  ordered_list: "list",
  list_item: "list_item",
  blockquote: "blockquote",
  code_block: "code_block",
  table: "table",
};

export interface PmOwnerBlock {
  readonly range: { readonly from: number; readonly to: number };
  readonly node: PmNode;
  readonly address: BlockOwnerAddress;
}

const ownerMarkdownByView = new WeakMap<EditorView, string>();

/** Bind this fragment's display markdown (`getDisplayMarkdown`) to the live view.
 *  Owner addresses are looked up in `buildOwnerTree` of that string. Never bind a
 *  `proseMirrorNodeToMarkdown` serialize — that round-trip is not byte-identical
 *  to the paint string, so fingerprints would disagree with static binds. */
export function bindEditorOwnerMarkdown(view: EditorView, markdown: string): void {
  ownerMarkdownByView.set(view, markdown);
}

export function unbindEditorOwnerMarkdown(view: EditorView): void {
  ownerMarkdownByView.delete(view);
}

export function boundEditorOwnerMarkdown(view: EditorView): string | undefined {
  return ownerMarkdownByView.get(view);
}

function ownerRootIndexAmongSiblings(doc: PmNode, topLevelIndex: number): number {
  let ownerIndex = 0;
  for (let i = 0; i < topLevelIndex; i++) {
    const child = doc.maybeChild(i);
    if (child && PM_OWNER_KIND_BY_NODE_TYPE[child.type.name]) ownerIndex++;
  }
  return ownerIndex;
}

/**
 * Resolves the PM ancestor of `pos` that is an owner-tree block: a heading, paragraph, list
 * item, blockquote, code block, or table. Walks from the document root inward and stops at
 * the first match, so a hit inside a blockquote's paragraph or a table's row/cell resolves
 * to the blockquote/table, and a hit inside a list resolves to the containing list item,
 * never the list itself — the same nesting rules `resolveStaticOwnerElement` applies to the
 * static-markdown DOM.
 *
 * The address is looked up in `buildOwnerTree` of the display markdown bound on
 * this view (`bindEditorOwnerMarkdown`). That is the same string a static bind
 * for this fragment uses. The resolver does not serialize `view.state.doc`.
 */
export function resolveOwnerBlockAtPos(view: EditorView, pos: number): PmOwnerBlock | null {
  const markdown = ownerMarkdownByView.get(view);
  if (markdown == null) return null;
  const $pos = view.state.doc.resolve(pos);
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    const kind = PM_OWNER_KIND_BY_NODE_TYPE[node.type.name];
    if (!kind || kind === "list") continue;

    const from = $pos.before(depth);
    const to = from + node.nodeSize;
    const tree = buildOwnerTree(markdown);
    const rootIndex = ownerRootIndexAmongSiblings(view.state.doc, $pos.index(0));
    const entry: BlockOwnerNode | undefined =
      kind === "list_item" ? tree[rootIndex]?.children[$pos.index(1)] : tree[rootIndex];
    if (!entry) return null;
    return { range: { from, to }, node, address: entry.address };
  }
  return null;
}

export function resolveOwnerBlockByAddress(
  view: EditorView,
  address: BlockOwnerAddress,
): PmOwnerBlock | null {
  const markdown = ownerMarkdownByView.get(view);
  if (markdown == null) return null;
  const tree = buildOwnerTree(markdown);
  const doc = view.state.doc;
  let pos = 0;
  let ownerIndex = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const from = pos;
    const to = pos + child.nodeSize;
    pos = to;
    const kind = PM_OWNER_KIND_BY_NODE_TYPE[child.type.name];
    if (!kind) continue;
    if (ownerIndex === address.path[0]) {
      if (address.kind === "list_item" && kind === "list") {
        let itemPos = from + 1;
        let itemIndex = 0;
        for (let j = 0; j < child.childCount; j++) {
          const item = child.child(j);
          const itemFrom = itemPos;
          const itemTo = itemPos + item.nodeSize;
          itemPos = itemTo;
          if (PM_OWNER_KIND_BY_NODE_TYPE[item.type.name] !== "list_item") continue;
          if (itemIndex === address.path[1]) {
            const entry = tree[ownerIndex]?.children[itemIndex];
            if (!entry || !blockOwnerAddressesEqual(entry.address, address)) return null;
            return { range: { from: itemFrom, to: itemTo }, node: item, address: entry.address };
          }
          itemIndex += 1;
        }
        return null;
      }
      const entry = tree[ownerIndex];
      if (!entry || !blockOwnerAddressesEqual(entry.address, address)) return null;
      return { range: { from, to }, node: child, address: entry.address };
    }
    ownerIndex += 1;
  }
  return null;
}

/** A resolved owner block plus its rendered bounding rect and flat `kind`, for callers
 *  that hit-test a live PM editor (the grip and hover resolvers) rather than walking the
 *  structural tree directly. Both resolvers below produce this same shape, with the same
 *  address-equality guarantee `resolveOwnerBlockAtPos` documents. */
export interface PmOwnerHit extends PmOwnerBlock {
  readonly rect: DOMRect;
  readonly kind: BlockOwnerKind;
}

function withRect(view: EditorView, resolved: PmOwnerBlock): PmOwnerHit {
  const dom = view.nodeDOM(resolved.range.from);
  const rect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : new DOMRect();
  return { ...resolved, rect, kind: resolved.address.kind };
}

/**
 * Resolves the block the BlockEdit handle is beside. Crepe parks the handle in
 * the gutter (Floating UI `left` + 16px offset), so a point just past the
 * handle's right edge is still outside `view.dom` and `posAtCoords` returns
 * null. Crepe's own active-block hit-test uses the editor's horizontal center
 * at the pointer Y; this uses that same X at the handle's vertical center.
 */
export function resolveGrippedBlock(view: EditorView, handleRect: DOMRect): PmOwnerHit | null {
  const editorRect = view.dom.getBoundingClientRect();
  const probe = {
    left: editorRect.left + editorRect.width / 2,
    top: handleRect.top + handleRect.height / 2,
  };
  const coords = view.posAtCoords(probe);
  if (!coords) return null;
  const resolved = resolveOwnerBlockAtPos(view, coords.pos);
  return resolved ? withRect(view, resolved) : null;
}

/**
 * Resolves an arbitrary DOM node inside a mounted PM editor (a pointer-hover hit, typically
 * found via `elementFromPoint`/`closest` against that editor's `.ProseMirror` root) to its
 * owning PM block, via `EditorView.posAtDOM`. Same address-equality guarantee as
 * `resolveGrippedBlock` and `resolveOwnerBlockAtPos`: both look up the bound
 * display markdown's owner tree.
 */
export function resolveHoverOwnerBlock(view: EditorView, hit: Node): PmOwnerHit | null {
  const pos = view.posAtDOM(hit, 0);
  if (pos < 0) return null;
  const resolved = resolveOwnerBlockAtPos(view, pos);
  return resolved ? withRect(view, resolved) : null;
}
