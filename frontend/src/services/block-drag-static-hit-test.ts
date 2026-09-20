import type { BlockOwnerKind } from "./block-drag-model";
import {
  BLOCK_OWNER_FINGERPRINT_ATTR,
  BLOCK_OWNER_FRAGMENT_VERSION_ATTR,
  BLOCK_OWNER_KIND_ATTR,
  BLOCK_OWNER_PATH_ATTR,
} from "./block-drag-static-bind";

export interface StaticOwnerHit {
  readonly element: Element;
  readonly path: readonly number[];
  readonly kind: BlockOwnerKind;
  readonly fingerprint: string;
  readonly fragmentVersion: number;
}

const OWNER_ATTR_SELECTOR = `[${BLOCK_OWNER_PATH_ATTR}]`;

/**
 * Resolves a DOM hit inside a static-markdown-rendered section to the block-owner
 * element that owns it. `remarkStampBlockOwnerAddresses` stamps only owner-boundary
 * elements (root owners and list items), so `closest` already gives the right node
 * for every nested-hit rule this needs: a hit on a list item's own content resolves
 * to that item; a hit on the list container's own gap (not covered by any item)
 * resolves to the list; a hit inside a blockquote's paragraph or a table's row/cell
 * resolves to the blockquote/table, since those descendants carry no stamp of
 * their own.
 */
export function resolveStaticOwnerElement(hit: Element, root: Element): StaticOwnerHit | null {
  const owner = hit.closest(OWNER_ATTR_SELECTOR);
  if (!owner || !root.contains(owner)) return null;

  const path = owner.getAttribute(BLOCK_OWNER_PATH_ATTR);
  const kind = owner.getAttribute(BLOCK_OWNER_KIND_ATTR) as BlockOwnerKind | null;
  const fingerprint = owner.getAttribute(BLOCK_OWNER_FINGERPRINT_ATTR);
  const fragmentVersionAttr = owner.getAttribute(BLOCK_OWNER_FRAGMENT_VERSION_ATTR);
  if (path === null || kind === null || fingerprint === null || fragmentVersionAttr === null) return null;

  return {
    element: owner,
    path: path.split(",").map(Number),
    kind,
    fingerprint,
    fragmentVersion: Number(fragmentVersionAttr),
  };
}
