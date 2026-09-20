import type { Root } from "mdast";
import { forEachOwnerNode, blockOwnerAddress, type BlockOwnerMdastNode } from "./block-drag-model";

export const BLOCK_OWNER_PATH_ATTR = "data-owner-path";
export const BLOCK_OWNER_KIND_ATTR = "data-owner-kind";
export const BLOCK_OWNER_FINGERPRINT_ATTR = "data-owner-fingerprint";
export const BLOCK_OWNER_FRAGMENT_VERSION_ATTR = "data-owner-fragment-version";

export interface RemarkStampBlockOwnerAddressesOptions {
  readonly fragmentVersion: number;
}

interface OwnerStampNode {
  data?: { hProperties?: Record<string, string> } | undefined;
}

function stampNode(
  node: BlockOwnerMdastNode,
  markdown: string,
  path: readonly number[],
  kind: Parameters<typeof blockOwnerAddress>[3],
  fragmentVersion: number,
): void {
  const address = blockOwnerAddress(markdown, node, path, kind);
  const stampable = node as unknown as OwnerStampNode;
  const data = stampable.data ?? (stampable.data = {});
  data.hProperties = {
    ...data.hProperties,
    [BLOCK_OWNER_PATH_ATTR]: address.path.join(","),
    [BLOCK_OWNER_KIND_ATTR]: address.kind,
    [BLOCK_OWNER_FINGERPRINT_ATTR]: address.fingerprint,
    [BLOCK_OWNER_FRAGMENT_VERSION_ATTR]: String(fragmentVersion),
  };
}

/**
 * Remark plugin (unified attacher) that stamps every block-owner tree address, plus the
 * fragment version it was rendered from, onto the mdast node that owns it, via
 * `data.hProperties`. `mdast-util-to-hast` (react-markdown's mdast -> hast step) merges
 * those properties onto the rendered element, so the DOM node that owns a drop position
 * carries the same address `buildOwnerTree` computes for it, plus a version a drag
 * session can compare at commit time to refuse a bind whose target has since re-rendered
 * from a different fragment version (a stale bind).
 */
export function remarkStampBlockOwnerAddresses(options: RemarkStampBlockOwnerAddressesOptions) {
  return (tree: Root, file: { toString(): string }) => {
    const markdown = file.toString();
    forEachOwnerNode(tree, ({ node, path, kind }) => {
      stampNode(node, markdown, path, kind, options.fragmentVersion);
    });
  };
}
