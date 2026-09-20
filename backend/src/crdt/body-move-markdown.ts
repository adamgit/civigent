import { getRemarkProcessor, getSchema, jsonToMarkdown, markdownToJSON } from "@ks/milkdown-serializer";

export type BodyMoveOwnerKind =
  | "heading"
  | "paragraph"
  | "list"
  | "list_item"
  | "blockquote"
  | "code_block"
  | "table";

export interface BodyMoveOwnerAddress {
  readonly path: readonly number[];
  readonly kind: BodyMoveOwnerKind;
  readonly fingerprint: string;
}

const ROOT_OWNER_KIND_BY_MDAST_TYPE: Partial<Record<string, BodyMoveOwnerKind>> = {
  heading: "heading",
  paragraph: "paragraph",
  list: "list",
  blockquote: "blockquote",
  table: "table",
  code: "code_block",
};

interface MdastPos {
  readonly start?: { readonly offset?: number };
  readonly end?: { readonly offset?: number };
}

interface MdastNode {
  readonly type: string;
  readonly position?: MdastPos;
  readonly children?: readonly MdastNode[];
}

function fingerprintOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function addressesEqual(a: BodyMoveOwnerAddress, b: BodyMoveOwnerAddress): boolean {
  return (
    a.kind === b.kind
    && a.fingerprint === b.fingerprint
    && a.path.length === b.path.length
    && a.path.every((index, i) => index === b.path[i])
  );
}

function ownerMatchesAddress(markdown: string, address: BodyMoveOwnerAddress): boolean {
  const root = getRemarkProcessor().parse(markdown) as unknown as { children: readonly MdastNode[] };
  let rootIndex = 0;
  for (const child of root.children) {
    const kind = ROOT_OWNER_KIND_BY_MDAST_TYPE[child.type];
    if (!kind) continue;
    const pos = child.position;
    if (
      pos?.start?.offset != null
      && pos.end?.offset != null
      && addressesEqual(address, {
        path: [rootIndex],
        kind,
        fingerprint: fingerprintOf(markdown.slice(pos.start.offset, pos.end.offset)),
      })
    ) {
      return true;
    }
    if (kind === "list" && child.children) {
      let itemIndex = 0;
      for (const item of child.children) {
        if (item.type !== "listItem") continue;
        const itemPos = item.position;
        if (
          itemPos?.start?.offset != null
          && itemPos.end?.offset != null
          && addressesEqual(address, {
            path: [rootIndex, itemIndex],
            kind: "list_item",
            fingerprint: fingerprintOf(markdown.slice(itemPos.start.offset, itemPos.end.offset)),
          })
        ) {
          return true;
        }
        itemIndex += 1;
      }
    }
    rootIndex += 1;
  }
  return false;
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
  address: BodyMoveOwnerAddress,
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
  kind: BodyMoveOwnerKind,
  edge: "before" | "after",
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
  address: BodyMoveOwnerAddress,
  edge: "before" | "after",
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
  sourceAddress: BodyMoveOwnerAddress,
  targetAddress: BodyMoveOwnerAddress,
  edge: "before" | "after",
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

export function applyBodyMoveToMarkdown(args: {
  sourceMarkdown: string;
  targetMarkdown: string;
  sourceAddress: BodyMoveOwnerAddress;
  targetAddress: BodyMoveOwnerAddress;
  edge: "before" | "after";
  serializedNode: string;
}): { sourceMarkdown: string; targetMarkdown: string } | null {
  if (!ownerMatchesAddress(args.sourceMarkdown, args.sourceAddress)) return null;
  if (!ownerMatchesAddress(
    args.sourceMarkdown === args.targetMarkdown ? args.sourceMarkdown : args.targetMarkdown,
    args.targetAddress,
  )) {
    return null;
  }
  const incoming = plainPmBlockFromSerialized(args.serializedNode);
  if (!incoming) return null;

  if (args.sourceMarkdown === args.targetMarkdown) {
    const next = applySameFragmentMove(
      args.sourceMarkdown,
      args.sourceAddress,
      args.targetAddress,
      args.edge,
      incoming,
    );
    if (next == null) return null;
    return { sourceMarkdown: next, targetMarkdown: next };
  }

  const sourceDoc = clonePmJson(markdownToJSON(args.sourceMarkdown) as unknown as PmJsonNode);
  const targetDoc = clonePmJson(markdownToJSON(args.targetMarkdown) as unknown as PmJsonNode);
  const sourceLoc = locatePmOwner(sourceDoc, args.sourceAddress);
  if (!sourceLoc) return null;
  sourceLoc.siblings.splice(sourceLoc.index, 1);
  if (args.sourceAddress.kind === "list_item") removeEmptyListIfNeeded(sourceDoc, sourceLoc.parent);
  if (!insertAtOwnerSlot(targetDoc, args.targetAddress, args.edge, incoming)) return null;
  const sourceNext = serializePmDoc(sourceDoc);
  const targetNext = serializePmDoc(targetDoc);
  if (sourceNext == null || targetNext == null) return null;
  return { sourceMarkdown: sourceNext, targetMarkdown: targetNext };
}
