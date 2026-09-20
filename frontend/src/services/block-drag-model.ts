import type { Heading, List, ListItem, Root, RootContent } from "mdast";
import { getRemarkProcessor, getSchema, jsonToMarkdown, markdownToJSON } from "@ks/milkdown-serializer";

export type BlockOwnerKind =
  | "heading"
  | "paragraph"
  | "list"
  | "list_item"
  | "blockquote"
  | "code_block"
  | "table";

export interface BlockOwnerAddress {
  readonly path: readonly number[];
  readonly kind: BlockOwnerKind;
  readonly fingerprint: string;
}

export type BlockDropEdge = "before" | "after";

export interface BlockDropSlot {
  readonly fragmentKey: string;
  readonly owner: BlockOwnerAddress;
  readonly edge: BlockDropEdge;
}

export interface BodyMoveRequest {
  readonly sourceFragmentKey: string;
  readonly targetFragmentKey: string;
  readonly sourceAddress: BlockOwnerAddress;
  readonly targetAddress: BlockOwnerAddress;
  readonly edge: BlockDropEdge;
  readonly serializedNode: string;
}

export type GripSourceKind = "identity-heading" | "embedded-heading" | "body-block";

export type GripCommitKind = "outline-move" | "content-move" | "intra-section" | "refuse";

export interface GripCommitClassification {
  readonly sourceKind: GripSourceKind;
  readonly targetIsOtherSection: boolean;
}

/**
 * Which mutation a grip drop means, from what was gripped and whether the drop left the
 * section that started the drag.
 *
 * An identity heading is the section itself, so it moves the outline and only ever onto
 * another section; dropping it inside its own body would leave the section without its
 * leading heading. An embedded heading is a structural object in this product, so it may
 * be reordered within its own section but never transplanted into another one. A body
 * block reorders in place or transplants between two fragments.
 */
export function classifyGripCommit({
  sourceKind,
  targetIsOtherSection,
}: GripCommitClassification): GripCommitKind {
  switch (sourceKind) {
    case "identity-heading":
      return targetIsOtherSection ? "outline-move" : "refuse";
    case "embedded-heading":
      return targetIsOtherSection ? "refuse" : "intra-section";
    case "body-block":
      return targetIsOtherSection ? "content-move" : "intra-section";
  }
}

export interface BlockOwnerNode {
  readonly address: BlockOwnerAddress;
  readonly children: readonly BlockOwnerNode[];
}

const ROOT_OWNER_KIND_BY_MDAST_TYPE: Partial<Record<string, BlockOwnerKind>> = {
  heading: "heading",
  paragraph: "paragraph",
  list: "list",
  blockquote: "blockquote",
  table: "table",
  code: "code_block",
};

/** An owner-eligible mdast node: a root-level owner, or a list's list-item child. */
export type BlockOwnerMdastNode = RootContent | ListItem;

export interface BlockOwnerVisit {
  readonly node: BlockOwnerMdastNode;
  readonly path: readonly number[];
  readonly kind: BlockOwnerKind;
}

/**
 * Walks the top-level owners of a parsed mdast root, in document order, and each
 * owned list's list-item children. This is the single traversal both `buildOwnerTree`
 * and the static-markdown stamping plugin use, so a rendered element's address is
 * always computed the same way it is in the structural tree.
 */
export function forEachOwnerNode(root: Root, visit: (v: BlockOwnerVisit) => void): void {
  let rootIndex = 0;
  for (const child of root.children) {
    const kind = ROOT_OWNER_KIND_BY_MDAST_TYPE[child.type];
    if (!kind) continue;
    const path = [rootIndex];
    visit({ node: child, path, kind });
    if (kind === "list") {
      let itemIndex = 0;
      for (const item of (child as List).children) {
        if (item.type !== "listItem") continue;
        visit({ node: item, path: [rootIndex, itemIndex], kind: "list_item" });
        itemIndex++;
      }
    }
    rootIndex++;
  }
}

function fingerprintOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sourceSlice(markdown: string, node: BlockOwnerMdastNode): string {
  const position = node.position;
  if (!position || position.start.offset == null || position.end.offset == null) {
    return "";
  }
  return markdown.slice(position.start.offset, position.end.offset);
}

export function blockOwnerAddress(
  markdown: string,
  node: BlockOwnerMdastNode,
  path: readonly number[],
  kind: BlockOwnerKind,
): BlockOwnerAddress {
  return { path, kind, fingerprint: fingerprintOf(sourceSlice(markdown, node)) };
}

export function buildOwnerTree(markdown: string): readonly BlockOwnerNode[] {
  const root = getRemarkProcessor().parse(markdown) as unknown as Root;
  const roots: BlockOwnerNode[] = [];
  const rootsByIndex = new Map<number, { address: BlockOwnerAddress; children: BlockOwnerNode[] }>();
  forEachOwnerNode(root, ({ node, path, kind }) => {
    const address = blockOwnerAddress(markdown, node, path, kind);
    if (path.length === 1) {
      const entry = { address, children: [] };
      rootsByIndex.set(path[0], entry);
      roots.push(entry);
    } else {
      rootsByIndex.get(path[0])?.children.push({ address, children: [] });
    }
  });
  return roots;
}

export interface GripSourceIdentity {
  readonly heading: string;
  readonly headingLevel: number;
}

export interface GripSourceClassification {
  readonly owner: BlockOwnerAddress;
  readonly markdown: string;
  readonly identity: GripSourceIdentity | null;
}

function mdastText(node: { value?: string; children?: readonly unknown[] }): string {
  if (typeof node.value === "string") return node.value;
  if (!node.children) return "";
  let text = "";
  for (const child of node.children) {
    text += mdastText(child as { value?: string; children?: readonly unknown[] });
  }
  return text;
}

export function blockOwnerAddressesEqual(a: BlockOwnerAddress, b: BlockOwnerAddress): boolean {
  return (
    a.kind === b.kind &&
    a.fingerprint === b.fingerprint &&
    a.path.length === b.path.length &&
    a.path.every((index, i) => index === b.path[i])
  );
}

function identityHeadingAddress(
  markdown: string,
  identity: GripSourceIdentity,
): BlockOwnerAddress | null {
  const root = getRemarkProcessor().parse(markdown) as unknown as Root;
  let first: BlockOwnerAddress | null = null;
  let matched: BlockOwnerAddress | null = null;
  forEachOwnerNode(root, ({ node, path, kind }) => {
    if (kind !== "heading") return;
    const address = blockOwnerAddress(markdown, node, path, kind);
    if (!first) first = address;
    if (matched) return;
    const heading = node as Heading;
    if (
      heading.depth === identity.headingLevel &&
      mdastText(heading).toLowerCase() === identity.heading.toLowerCase()
    ) {
      matched = address;
    }
  });
  return matched ?? first;
}

export function classifyGripSourceKind({
  owner,
  markdown,
  identity,
}: GripSourceClassification): GripSourceKind {
  if (owner.kind !== "heading") return "body-block";
  if (!identity) return "embedded-heading";
  const identityAddress = identityHeadingAddress(markdown, identity);
  if (identityAddress && blockOwnerAddressesEqual(owner, identityAddress)) {
    return "identity-heading";
  }
  return "embedded-heading";
}

export interface BodyMoveMarkdownArgs {
  readonly sourceMarkdown: string;
  readonly targetMarkdown: string;
  readonly sourceAddress: BlockOwnerAddress;
  readonly targetAddress: BlockOwnerAddress;
  readonly edge: BlockDropEdge;
  readonly serializedNode: string;
}

export interface BodyMoveMarkdownResult {
  readonly sourceMarkdown: string;
  readonly targetMarkdown: string;
}

function ownerMatchesAddress(markdown: string, address: BlockOwnerAddress): boolean {
  const root = getRemarkProcessor().parse(markdown) as unknown as Root;
  let matched = false;
  forEachOwnerNode(root, ({ node, path, kind }) => {
    if (matched) return;
    if (blockOwnerAddressesEqual(blockOwnerAddress(markdown, node, path, kind), address)) {
      matched = true;
    }
  });
  return matched;
}

interface PmJsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmJsonNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

const PM_ROOT_OWNER_TYPES = new Set([
  "heading",
  "paragraph",
  "bullet_list",
  "ordered_list",
  "blockquote",
  "code_block",
  "table",
]);

function clonePmJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stripUnsupportedMarks(node: PmJsonNode): void {
  if (node.marks) {
    node.marks = node.marks.filter((mark) => mark.type !== "ychange");
  }
  if (node.content) {
    for (const child of node.content) stripUnsupportedMarks(child);
  }
}

function plainPmBlockFromSerialized(serializedNode: string): PmJsonNode | null {
  let raw: unknown;
  try {
    raw = JSON.parse(serializedNode);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as PmJsonNode;
  const candidate = obj.type === "doc" && obj.content?.length === 1 ? obj.content[0] : obj;
  if (!candidate || typeof candidate.type !== "string" || candidate.type === "doc") return null;
  const plain = clonePmJson(candidate);
  stripUnsupportedMarks(plain);
  try {
    return clonePmJson(getSchema().nodeFromJSON(plain).toJSON() as PmJsonNode);
  } catch {
    return null;
  }
}

function locatePmOwner(
  doc: PmJsonNode,
  address: BlockOwnerAddress,
): { parent: PmJsonNode; siblings: PmJsonNode[]; index: number } | null {
  const siblings = doc.content;
  if (!siblings) return null;
  if (address.kind === "list_item") {
    let rootIndex = 0;
    for (const child of siblings) {
      if (!PM_ROOT_OWNER_TYPES.has(child.type)) continue;
      if (rootIndex === address.path[0]) {
        if (child.type !== "bullet_list" && child.type !== "ordered_list") return null;
        const items = child.content;
        if (!items) return null;
        let itemIndex = 0;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type !== "list_item") continue;
          if (itemIndex === address.path[1]) return { parent: child, siblings: items, index: i };
          itemIndex += 1;
        }
        return null;
      }
      rootIndex += 1;
    }
    return null;
  }
  let rootIndex = 0;
  for (let i = 0; i < siblings.length; i++) {
    if (!PM_ROOT_OWNER_TYPES.has(siblings[i].type)) continue;
    if (rootIndex === address.path[0]) return { parent: doc, siblings, index: i };
    rootIndex += 1;
  }
  return null;
}

function fitIncomingForSlot(incoming: PmJsonNode, into: "root" | "list_item"): PmJsonNode[] | null {
  const schema = getSchema();
  if (into === "list_item") {
    if (incoming.type === "list_item") return [incoming];
    if (incoming.type === "bullet_list" || incoming.type === "ordered_list") {
      const items = incoming.content?.filter((node) => node.type === "list_item") ?? [];
      return items.length > 0 ? items : null;
    }
    try {
      return [clonePmJson(schema.nodeFromJSON({ type: "list_item", content: [incoming] }).toJSON() as PmJsonNode)];
    } catch {
      return null;
    }
  }
  if (incoming.type === "list_item") {
    const listType = incoming.attrs?.listType === "ordered" ? "ordered_list" : "bullet_list";
    try {
      return [clonePmJson(schema.nodeFromJSON({ type: listType, content: [incoming] }).toJSON() as PmJsonNode)];
    } catch {
      return null;
    }
  }
  try {
    schema.nodeFromJSON(incoming);
    return [incoming];
  } catch {
    return null;
  }
}

function removeEmptyListIfNeeded(doc: PmJsonNode, list: PmJsonNode): void {
  if ((list.content?.length ?? 0) > 0) return;
  const roots = doc.content;
  if (!roots) return;
  const index = roots.indexOf(list);
  if (index >= 0) roots.splice(index, 1);
}

function insertIncomingAtLocation(
  doc: PmJsonNode,
  loc: { parent: PmJsonNode; siblings: PmJsonNode[]; index: number },
  kind: BlockOwnerKind,
  edge: BlockDropEdge,
  incoming: PmJsonNode,
): boolean {
  if (kind === "list_item") {
    const asItems = fitIncomingForSlot(incoming, "list_item");
    if (asItems) {
      loc.siblings.splice(edge === "before" ? loc.index : loc.index + 1, 0, ...asItems);
      return true;
    }
    const asRoot = fitIncomingForSlot(incoming, "root");
    if (!asRoot) return false;
    const splitAt = edge === "before" ? loc.index : loc.index + 1;
    const before = loc.siblings.slice(0, splitAt);
    const after = loc.siblings.slice(splitAt);
    const roots = doc.content;
    if (!roots) return false;
    const listIndex = roots.indexOf(loc.parent);
    if (listIndex < 0) return false;
    const replacement: PmJsonNode[] = [];
    if (before.length > 0) replacement.push({ ...loc.parent, content: before });
    replacement.push(...asRoot);
    if (after.length > 0) replacement.push({ ...loc.parent, content: after });
    roots.splice(listIndex, 1, ...replacement);
    return true;
  }
  const nodes = fitIncomingForSlot(incoming, "root");
  if (!nodes) return false;
  loc.siblings.splice(edge === "before" ? loc.index : loc.index + 1, 0, ...nodes);
  return true;
}

function insertAtOwnerSlot(
  doc: PmJsonNode,
  address: BlockOwnerAddress,
  edge: BlockDropEdge,
  incoming: PmJsonNode,
): boolean {
  const loc = locatePmOwner(doc, address);
  if (!loc) return false;
  return insertIncomingAtLocation(doc, loc, address.kind, edge, incoming);
}

function serializePmDoc(doc: PmJsonNode): string | null {
  if (!doc.content || doc.content.length === 0) return "";
  try {
    return jsonToMarkdown(doc as unknown as Record<string, unknown>);
  } catch {
    return null;
  }
}

function applySameFragmentMove(
  markdown: string,
  sourceAddress: BlockOwnerAddress,
  targetAddress: BlockOwnerAddress,
  edge: BlockDropEdge,
  incoming: PmJsonNode,
): string | null {
  const doc = clonePmJson(markdownToJSON(markdown) as unknown as PmJsonNode);
  const sourceLoc = locatePmOwner(doc, sourceAddress);
  const targetLoc = locatePmOwner(doc, targetAddress);
  if (!sourceLoc || !targetLoc) return null;
  const srcIndex = sourceLoc.index;
  const sameSiblings = sourceLoc.siblings === targetLoc.siblings;
  const sourceList = sourceAddress.kind === "list_item" ? sourceLoc.parent : null;
  const targetLivedInSourceList = sourceList != null && targetLoc.parent === sourceList;
  const movingOntoSourceList = sourceList != null
    && targetAddress.kind === "list"
    && targetLoc.siblings[targetLoc.index] === sourceList;
  const sourceListIndex = sourceList && doc.content ? doc.content.indexOf(sourceList) : -1;
  sourceLoc.siblings.splice(srcIndex, 1);
  if (sameSiblings && srcIndex < targetLoc.index) targetLoc.index -= 1;
  if (sourceList && (sourceList.content?.length ?? 0) === 0) {
    if (doc.content && sourceListIndex >= 0) doc.content.splice(sourceListIndex, 1);
    if (targetLivedInSourceList || movingOntoSourceList) {
      const nodes = fitIncomingForSlot(incoming, "root");
      if (!nodes || !doc.content) return null;
      doc.content.splice(sourceListIndex, 0, ...nodes);
      return serializePmDoc(doc);
    }
  }
  if (!insertIncomingAtLocation(doc, targetLoc, targetAddress.kind, edge, incoming)) return null;
  return serializePmDoc(doc);
}

export function applyBodyMoveToMarkdown({
  sourceMarkdown,
  targetMarkdown,
  sourceAddress,
  targetAddress,
  edge,
  serializedNode,
}: BodyMoveMarkdownArgs): BodyMoveMarkdownResult | null {
  if (!ownerMatchesAddress(sourceMarkdown, sourceAddress)) return null;
  if (!ownerMatchesAddress(sourceMarkdown === targetMarkdown ? sourceMarkdown : targetMarkdown, targetAddress)) {
    return null;
  }
  const incoming = plainPmBlockFromSerialized(serializedNode);
  if (!incoming) return null;

  if (sourceMarkdown === targetMarkdown) {
    const next = applySameFragmentMove(sourceMarkdown, sourceAddress, targetAddress, edge, incoming);
    if (next == null) return null;
    return { sourceMarkdown: next, targetMarkdown: next };
  }

  const sourceDoc = clonePmJson(markdownToJSON(sourceMarkdown) as unknown as PmJsonNode);
  const targetDoc = clonePmJson(markdownToJSON(targetMarkdown) as unknown as PmJsonNode);
  const sourceLoc = locatePmOwner(sourceDoc, sourceAddress);
  if (!sourceLoc) return null;
  sourceLoc.siblings.splice(sourceLoc.index, 1);
  if (sourceAddress.kind === "list_item") removeEmptyListIfNeeded(sourceDoc, sourceLoc.parent);
  if (!insertAtOwnerSlot(targetDoc, targetAddress, edge, incoming)) return null;
  const sourceNext = serializePmDoc(sourceDoc);
  const targetNext = serializePmDoc(targetDoc);
  if (sourceNext == null || targetNext == null) return null;
  return { sourceMarkdown: sourceNext, targetMarkdown: targetNext };
}
