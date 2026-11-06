import type { EditorView } from "@milkdown/prose/view";
import { Fragment, type Node as PmNode } from "@milkdown/prose/model";
import { ySyncPluginKey } from "y-prosemirror";
import {
  SectionId,
  BEFORE_FIRST_HEADING_SECTION_ID,
  type LiveSectionRef,
} from "../types/live-sections";

const FINGERPRINT_RADIUS = 24;
const FINGERPRINT_MATCH_LENGTH = 12;
const FINGERPRINT_MIN_SEARCH_LENGTH = 6;

export type SplitCaretLocation =
  | { kind: "kept-prefix" }
  | { kind: "leading-chunk"; offset: number; chunk: string }
  | {
      kind: "promoted";
      headingOrdinal: number;
      slot: "heading" | "body";
      offset: number;
    };

export interface CaretFingerprint {
  before: string;
  after: string;
}

export interface YSyncBindingLike {
  type: { length?: number };
  mapping: unknown;
}

export interface CaretCapture {
  sourceFragmentKey: string;
  location: SplitCaretLocation;
  fingerprint: CaretFingerprint;
}

export type SplitCaretPlan =
  | { action: "stay"; sectionId: SectionId; fragmentKey: string }
  | {
      action: "follow-promotion";
      sectionId: SectionId;
      fragmentKey: string;
      slot: "heading" | "body";
      offset: number;
      fingerprint: CaretFingerprint;
    }
  | {
      action: "follow-predecessor";
      sectionId: SectionId;
      fragmentKey: string;
      slot: "body";
      offset: number;
      chunk: string;
    };

export interface SplitCaretPlacement {
  slot: "heading" | "body";
  offset?: number;
  fingerprint?: CaretFingerprint;
  match?: "first" | "last";
}

export interface SplitSurvivorIdentity {
  heading: string;
  headingLevel: number;
}

type OwningSplitRegion =
  | { kind: "kept-prefix" }
  | { kind: "leading-chunk" }
  | { kind: "promoted"; headingChildIndex: number; headingOrdinal: number };

export interface CaretFrameHooks {
  beforeApply(): CaretCapture | null;
  afterApply(
    capture: CaretCapture | null,
    prevTopology: readonly LiveSectionRef[],
    nextTopology: readonly LiveSectionRef[],
  ): void;
}

function posBeforeChild(doc: PmNode, childIndex: number): number {
  let pos = 0;
  for (let i = 0; i < childIndex; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function firstHeadingChildIndex(doc: PmNode): number | null {
  for (let i = 0; i < doc.childCount; i++) {
    if (doc.child(i).type.name === "heading") return i;
  }
  return null;
}

function leadingChunkEnd(doc: PmNode): number {
  const heading = firstHeadingChildIndex(doc);
  return heading === null ? doc.content.size : posBeforeChild(doc, heading);
}

function bodyTextRange(doc: PmNode): { start: number; end: number } {
  const heading = firstHeadingChildIndex(doc);
  if (heading === null) {
    return { start: doc.childCount === 0 ? 0 : posBeforeChild(doc, 0) + 1, end: doc.content.size };
  }
  const bodyChild = heading + 1;
  if (bodyChild >= doc.childCount) {
    const end = doc.content.size;
    return { start: end, end };
  }
  return { start: posBeforeChild(doc, bodyChild) + 1, end: doc.content.size };
}

function leadingChunkText(doc: PmNode): string {
  return doc.textBetween(0, leadingChunkEnd(doc), "\n");
}

function bodyPlainText(doc: PmNode): string {
  const range = bodyTextRange(doc);
  return doc.textBetween(range.start, range.end, "\n");
}

export function appendedChunkBodyOffset(
  source: PmNode,
  predecessor: PmNode,
  chunk: string,
  offset: number,
): number | null {
  if (chunk.trim().length === 0) return null;
  if (leadingChunkText(source) === chunk) return null;
  const bodyText = bodyPlainText(predecessor);
  if (!bodyText.endsWith(chunk)) return null;
  const dest = bodyText.length - (chunk.length - offset);
  if (dest < 0 || dest > bodyText.length) return null;
  return dest;
}

function textOffsetBetween(doc: PmNode, from: number, to: number): number {
  if (to <= from) return 0;
  return doc.textBetween(from, to, "\n").length;
}

function headingNodeMatches(node: PmNode, identity: SplitSurvivorIdentity): boolean {
  return (
    Number(node.attrs.level) === Number(identity.headingLevel) &&
    node.textContent.toLowerCase() === identity.heading.toLowerCase()
  );
}

export function survivorHeadingChildIndex(
  doc: PmNode,
  isBeforeFirstHeading: boolean,
  identity?: SplitSurvivorIdentity | null,
): number | null {
  if (isBeforeFirstHeading) return null;
  let first: number | null = null;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name !== "heading") continue;
    if (first === null) first = i;
    if (identity && headingNodeMatches(child, identity)) return i;
  }
  return first;
}

export function splitBoundaryChildIndex(
  doc: PmNode,
  isBeforeFirstHeading: boolean,
  identity?: SplitSurvivorIdentity | null,
): number | null {
  const survivor = survivorHeadingChildIndex(doc, isBeforeFirstHeading, identity);
  for (let i = 0; i < doc.childCount; i++) {
    if (doc.child(i).type.name === "heading" && i !== survivor) return i;
  }
  return null;
}

function owningSplitRegion(
  doc: PmNode,
  caretPos: number,
  isBeforeFirstHeading: boolean,
  identity?: SplitSurvivorIdentity | null,
): OwningSplitRegion {
  const survivor = survivorHeadingChildIndex(doc, isBeforeFirstHeading, identity);
  const clamped = Math.max(0, Math.min(caretPos, doc.content.size));
  const caretChild = doc.resolve(clamped).index(0);

  let owningHeading: number | null = null;
  let leavingOrdinal = -1;
  for (let i = 0; i <= Math.min(caretChild, doc.childCount - 1); i++) {
    if (doc.child(i).type.name !== "heading") continue;
    if (survivor !== null && i === survivor) {
      owningHeading = i;
    } else {
      leavingOrdinal += 1;
      owningHeading = i;
    }
  }

  if (owningHeading === null) {
    if (isBeforeFirstHeading) return { kind: "kept-prefix" };
    return { kind: "leading-chunk" };
  }
  if (survivor !== null && owningHeading === survivor) return { kind: "kept-prefix" };
  if (leavingOrdinal < 0) return { kind: "kept-prefix" };
  return { kind: "promoted", headingChildIndex: owningHeading, headingOrdinal: leavingOrdinal };
}

export function locateCaretInSplit(
  doc: PmNode,
  caretPos: number,
  isBeforeFirstHeading: boolean,
  identity?: SplitSurvivorIdentity | null,
): SplitCaretLocation {
  const region = owningSplitRegion(doc, caretPos, isBeforeFirstHeading, identity);
  if (region.kind === "kept-prefix") return { kind: "kept-prefix" };
  const clamped = Math.max(0, Math.min(caretPos, doc.content.size));
  if (region.kind === "leading-chunk") {
    return {
      kind: "leading-chunk",
      offset: textOffsetBetween(doc, 0, clamped),
      chunk: doc.textBetween(0, leadingChunkEnd(doc), "\n"),
    };
  }
  const caretChild = doc.resolve(clamped).index(0);
  if (caretChild === region.headingChildIndex) {
    return {
      kind: "promoted",
      headingOrdinal: region.headingOrdinal,
      slot: "heading",
      offset: textOffsetBetween(doc, posBeforeChild(doc, region.headingChildIndex), clamped),
    };
  }
  return {
    kind: "promoted",
    headingOrdinal: region.headingOrdinal,
    slot: "body",
    offset: textOffsetBetween(doc, posBeforeChild(doc, region.headingChildIndex + 1), clamped),
  };
}

export function captureFingerprint(doc: PmNode, caretPos: number): CaretFingerprint {
  const clamped = Math.max(0, Math.min(caretPos, doc.content.size));
  return {
    before: doc
      .textBetween(Math.max(0, clamped - FINGERPRINT_RADIUS * 2), clamped, "\n")
      .slice(-FINGERPRINT_RADIUS),
    after: doc
      .textBetween(clamped, Math.min(doc.content.size, clamped + FINGERPRINT_RADIUS * 2), "\n")
      .slice(0, FINGERPRINT_RADIUS),
  };
}

function captureSlotFingerprint(
  doc: PmNode,
  caretPos: number,
  isBeforeFirstHeading: boolean,
  identity?: SplitSurvivorIdentity | null,
): CaretFingerprint {
  const region = owningSplitRegion(doc, caretPos, isBeforeFirstHeading, identity);
  if (region.kind === "kept-prefix") return captureFingerprint(doc, caretPos);
  const clamped = Math.max(0, Math.min(caretPos, doc.content.size));

  let slotStart: number;
  let slotEnd: number;
  if (region.kind === "leading-chunk") {
    let firstHeadingIndex = doc.childCount;
    for (let i = 0; i < doc.childCount; i++) {
      if (doc.child(i).type.name === "heading") {
        firstHeadingIndex = i;
        break;
      }
    }
    slotStart = 0;
    slotEnd = posBeforeChild(doc, firstHeadingIndex);
  } else {
    const caretChild = doc.resolve(clamped).index(0);
    if (caretChild === region.headingChildIndex) {
      slotStart = posBeforeChild(doc, region.headingChildIndex);
      slotEnd = posBeforeChild(doc, region.headingChildIndex + 1);
    } else {
      let nextHeadingIndex = doc.childCount;
      for (let i = region.headingChildIndex + 1; i < doc.childCount; i++) {
        if (doc.child(i).type.name === "heading") {
          nextHeadingIndex = i;
          break;
        }
      }
      slotStart = posBeforeChild(doc, region.headingChildIndex + 1);
      slotEnd = posBeforeChild(doc, nextHeadingIndex);
    }
  }

  return {
    before: doc
      .textBetween(Math.max(slotStart, clamped - FINGERPRINT_RADIUS * 2), clamped, "\n")
      .slice(-FINGERPRINT_RADIUS),
    after: doc
      .textBetween(clamped, Math.min(slotEnd, clamped + FINGERPRINT_RADIUS * 2), "\n")
      .slice(0, FINGERPRINT_RADIUS),
  };
}

export function captureCaretBeforeStructuralApply(
  fragmentKey: string,
  view: EditorView,
  identity?: SplitSurvivorIdentity | null,
): CaretCapture | null {
  const syncState = ySyncPluginKey.getState(view.state) as
    | { binding?: YSyncBindingLike | null }
    | undefined;
  if (!syncState?.binding) return null;
  const doc = view.state.doc;
  const head = view.state.selection.head;
  const isBfh = fragmentKey === SectionId.text(BEFORE_FIRST_HEADING_SECTION_ID);
  return {
    sourceFragmentKey: fragmentKey,
    location: locateCaretInSplit(doc, head, isBfh, identity),
    fingerprint: captureSlotFingerprint(doc, head, isBfh, identity),
  };
}

function sameTopologyIds(
  prev: readonly LiveSectionRef[],
  next: readonly LiveSectionRef[],
): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!SectionId.equals(prev[i].id, next[i].id)) return false;
  }
  return true;
}

export function planCaretAfterSplit(args: {
  location: SplitCaretLocation;
  sourceFragmentKey: string;
  fingerprint: CaretFingerprint;
  prevTopology: readonly LiveSectionRef[];
  nextTopology: readonly LiveSectionRef[];
}): SplitCaretPlan | null {
  const { location, sourceFragmentKey, fingerprint, prevTopology, nextTopology } = args;

  if (location.kind === "leading-chunk") {
    const sourceId = SectionId.brand(sourceFragmentKey);
    const sourceIndex = nextTopology.findIndex((r) => SectionId.equals(r.id, sourceId));
    if (sourceIndex <= 0) return null;
    const predecessor = nextTopology[sourceIndex - 1]!;
    return {
      action: "follow-predecessor",
      sectionId: predecessor.id,
      fragmentKey: SectionId.text(predecessor.id),
      slot: "body",
      offset: location.offset,
      chunk: location.chunk,
    };
  }

  if (sameTopologyIds(prevTopology, nextTopology)) return null;

  const sourceId = SectionId.brand(sourceFragmentKey);
  const sourcePresent = nextTopology.some((r) => SectionId.equals(r.id, sourceId));

  if (location.kind === "kept-prefix" && sourcePresent) {
    return { action: "stay", sectionId: sourceId, fragmentKey: sourceFragmentKey };
  }

  const prevIds = new Set(prevTopology.map((r) => r.id));
  const newRefs = nextTopology.filter((r) => !prevIds.has(r.id));
  if (newRefs.length === 0) return null;

  const ordinal =
    location.kind === "promoted"
      ? Math.max(0, Math.min(location.headingOrdinal, newRefs.length - 1))
      : 0;
  const target = newRefs[ordinal];
  return {
    action: "follow-promotion",
    sectionId: target.id,
    fragmentKey: SectionId.text(target.id),
    slot: location.kind === "promoted" ? location.slot : "body",
    offset: location.kind === "promoted" ? location.offset : 0,
    fingerprint,
  };
}

export function firstBodyBlockPos(doc: PmNode): number | null {
  if (doc.childCount < 2 || doc.child(0).type.name !== "heading") return null;
  return posBeforeChild(doc, 1) + 1;
}

export function ensureBodyBlock(doc: PmNode): PmNode {
  if (firstBodyBlockPos(doc) !== null) return doc;
  if (doc.childCount === 0 || doc.child(0).type.name !== "heading") return doc;
  const paraType = doc.type.schema.nodes.paragraph;
  if (!paraType) return doc;
  return doc.copy(doc.content.append(Fragment.from(paraType.create())));
}

export function insertBodyBlockIfMissing(view: EditorView): void {
  if (firstBodyBlockPos(view.state.doc) !== null) return;
  if (view.state.doc.childCount === 0 || view.state.doc.child(0).type.name !== "heading") return;
  const para = view.state.schema.nodes.paragraph?.create();
  if (!para) return;
  view.dispatch(view.state.tr.insert(view.state.doc.content.size, para));
}

function posAtOffsetWithinRange(
  doc: PmNode,
  rangeStart: number,
  rangeEnd: number,
  offset: number,
): number {
  if (offset <= 0) return rangeStart;
  let acc = 0;
  let emitted = false;
  let result = -1;
  let lastEnd = rangeStart;
  doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (pos < rangeStart) return true;
    if (pos >= rangeEnd) return false;
    if (node.isTextblock && emitted) acc += 1;
    if (node.isText) {
      const len = node.text?.length ?? 0;
      if (acc + len >= offset) {
        result = pos + Math.max(0, offset - acc);
        return false;
      }
      acc += len;
      emitted = true;
      lastEnd = pos + len;
      return false;
    }
    return true;
  });
  return result >= 0 ? result : lastEnd;
}

function fingerprintMatchesInRange(
  doc: PmNode,
  pos: number,
  rangeStart: number,
  rangeEnd: number,
  fingerprint: CaretFingerprint,
): boolean {
  const beforeNeedle = fingerprint.before.slice(-FINGERPRINT_MATCH_LENGTH);
  const afterNeedle = fingerprint.after.slice(0, FINGERPRINT_MATCH_LENGTH);
  const actualBefore = doc
    .textBetween(Math.max(rangeStart, pos - FINGERPRINT_RADIUS * 2), pos, "\n")
    .slice(-beforeNeedle.length || undefined);
  const actualAfter = doc
    .textBetween(pos, Math.min(rangeEnd, pos + FINGERPRINT_RADIUS * 2), "\n")
    .slice(0, afterNeedle.length);
  const beforeOk = beforeNeedle.length === 0 || actualBefore === beforeNeedle;
  const afterOk = afterNeedle.length === 0 || actualAfter === afterNeedle;
  return beforeOk && afterOk;
}

function slideWithinRange(
  doc: PmNode,
  rangeStart: number,
  rangeEnd: number,
  fingerprint: CaretFingerprint,
  match: "first" | "last" = "first",
): number | null {
  const beforeNeedle = fingerprint.before.slice(-FINGERPRINT_MATCH_LENGTH);
  const afterNeedle = fingerprint.after.slice(0, FINGERPRINT_MATCH_LENGTH);
  const needle = beforeNeedle + afterNeedle;
  if (needle.length < FINGERPRINT_MIN_SEARCH_LENGTH) return null;
  const rangeText = doc.textBetween(rangeStart, rangeEnd, "\n");
  const idx = match === "last" ? rangeText.lastIndexOf(needle) : rangeText.indexOf(needle);
  if (idx < 0) return null;
  return posAtOffsetWithinRange(doc, rangeStart, rangeEnd, idx + beforeNeedle.length);
}

export function pmPosForPlacement(doc: PmNode, target: SplitCaretPlacement): number {
  if (target.fingerprint === undefined) {
    if (target.slot === "heading") {
      const headingStart = posBeforeChild(doc, 0) + 1;
      const headingEnd = doc.childCount > 1 ? posBeforeChild(doc, 1) : doc.content.size;
      return posAtOffsetWithinRange(doc, headingStart, headingEnd, target.offset ?? 0);
    }
    const range = bodyTextRange(doc);
    return posAtOffsetWithinRange(doc, range.start, range.end, target.offset ?? 0);
  }
  const match = target.match ?? "first";
  if (target.slot === "heading") {
    const headingStart = posBeforeChild(doc, 0) + 1;
    const headingEnd = doc.childCount > 1 ? posBeforeChild(doc, 1) : doc.content.size;
    if (match === "last") {
      return slideWithinRange(doc, headingStart, headingEnd, target.fingerprint, "last") ?? headingStart;
    }
    const candidate = posAtOffsetWithinRange(doc, headingStart, headingEnd, target.offset ?? 0);
    if (fingerprintMatchesInRange(doc, candidate, headingStart, headingEnd, target.fingerprint)) {
      return candidate;
    }
    return slideWithinRange(doc, headingStart, headingEnd, target.fingerprint) ?? candidate;
  }

  const bodyStart = firstBodyBlockPos(doc);
  if (bodyStart === null) {
    if (match === "last") {
      return slideWithinRange(doc, 0, doc.content.size, target.fingerprint, "last") ?? 1;
    }
    return 1;
  }
  const bodyEnd = doc.content.size;
  if (match === "last") {
    return slideWithinRange(doc, bodyStart, bodyEnd, target.fingerprint, "last") ?? bodyStart;
  }
  const candidate = posAtOffsetWithinRange(doc, bodyStart, bodyEnd, target.offset ?? 0);
  if (fingerprintMatchesInRange(doc, candidate, bodyStart, bodyEnd, target.fingerprint)) {
    return candidate;
  }
  return slideWithinRange(doc, bodyStart, bodyEnd, target.fingerprint) ?? bodyStart;
}

export function sealEditorForCaretTransit(view: EditorView): void {
  view.dom.blur();
  view.setProps({ editable: () => false });
}
