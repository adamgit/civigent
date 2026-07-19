import type * as Y from "yjs";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as PmNode } from "@milkdown/prose/model";
import {
  ySyncPluginKey,
  getRelativeSelection,
  relativePositionToAbsolutePosition,
} from "y-prosemirror";
import {
  SectionId,
  BEFORE_FIRST_HEADING_SECTION_ID,
  type LiveSectionRef,
} from "../types/live-sections";

const FINGERPRINT_RADIUS = 24;
const FINGERPRINT_MATCH_LENGTH = 12;
const FINGERPRINT_MIN_SEARCH_LENGTH = 6;

export interface PromotedCaretAddress {
  headingOrdinalInPromoted: number;
  offsetInBlock: number;
}

export interface CaretFingerprint {
  before: string;
  after: string;
}

export interface YSyncBindingLike {
  type: Y.XmlFragment;
  mapping: unknown;
}

export interface CaretCapture {
  sourceFragmentKey: string;
  relSel: { type: unknown; anchor: unknown; head: unknown } | null;
  promotedAddress: PromotedCaretAddress | null;
  fingerprint: CaretFingerprint;
  binding: YSyncBindingLike;
}

export type CaretRecovery =
  | { kind: "survivor"; sectionId: SectionId; fragmentKey: string }
  | {
      kind: "retarget";
      sectionId: SectionId;
      fragmentKey: string;
      offsetInBlock: number;
      fingerprint: CaretFingerprint;
    };

export interface RetargetCaretPlacement {
  offsetInBlock: number;
  fingerprint: CaretFingerprint;
}

export interface CaretFrameHooks {
  beforeApply(): CaretCapture | null;
  afterApply(
    capture: CaretCapture | null,
    prevTopology: readonly LiveSectionRef[],
    nextTopology: readonly LiveSectionRef[],
    ydoc: Y.Doc,
  ): void;
}

function posBeforeChild(doc: PmNode, childIndex: number): number {
  let pos = 0;
  for (let i = 0; i < childIndex; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function textOffsetBetween(doc: PmNode, from: number, to: number): number {
  if (to <= from) return 0;
  return doc.textBetween(from, to, "\n").length;
}

export function splitBoundaryChildIndex(doc: PmNode, isBeforeFirstHeading: boolean): number | null {
  const boundaryHeadingOrdinal = isBeforeFirstHeading ? 0 : 1;
  let seen = 0;
  for (let i = 0; i < doc.childCount; i++) {
    if (doc.child(i).type.name === "heading") {
      if (seen === boundaryHeadingOrdinal) return i;
      seen += 1;
    }
  }
  return null;
}

export function computePromotedAddress(
  doc: PmNode,
  caretPos: number,
  isBeforeFirstHeading: boolean,
): PromotedCaretAddress | null {
  const boundary = splitBoundaryChildIndex(doc, isBeforeFirstHeading);
  if (boundary === null) return null;
  const clamped = Math.max(0, Math.min(caretPos, doc.content.size));
  const caretChild = doc.resolve(clamped).index(0);
  if (caretChild < boundary) return null;
  let ordinal = 0;
  let blockStart = boundary;
  for (let i = boundary + 1; i <= Math.min(caretChild, doc.childCount - 1); i++) {
    if (doc.child(i).type.name === "heading") {
      ordinal += 1;
      blockStart = i;
    }
  }
  return {
    headingOrdinalInPromoted: ordinal,
    offsetInBlock: textOffsetBetween(doc, posBeforeChild(doc, blockStart), clamped),
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

export function captureCaretBeforeStructuralApply(
  fragmentKey: string,
  view: EditorView,
): CaretCapture | null {
  const syncState = ySyncPluginKey.getState(view.state) as
    | { binding?: YSyncBindingLike | null }
    | undefined;
  const binding = syncState?.binding;
  if (!binding) return null;
  const doc = view.state.doc;
  const head = view.state.selection.head;
  const isBfh = fragmentKey === SectionId.text(BEFORE_FIRST_HEADING_SECTION_ID);
  return {
    sourceFragmentKey: fragmentKey,
    relSel: getRelativeSelection(
      binding as never,
      view.state,
    ) as CaretCapture["relSel"],
    promotedAddress: computePromotedAddress(doc, head, isBfh),
    fingerprint: captureFingerprint(doc, head),
    binding,
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

function relSelResolvesInSource(capture: CaretCapture, ydoc: Y.Doc): boolean {
  const rel = capture.relSel as { anchor?: unknown; head?: unknown } | null;
  if (!rel || rel.anchor == null || rel.head == null) return false;
  const anchorAbs = relativePositionToAbsolutePosition(
    ydoc,
    capture.binding.type,
    rel.anchor as never,
    capture.binding.mapping as never,
  );
  if (anchorAbs === null) return false;
  const headAbs = relativePositionToAbsolutePosition(
    ydoc,
    capture.binding.type,
    rel.head as never,
    capture.binding.mapping as never,
  );
  return headAbs !== null;
}

export function recoverCaret(args: {
  capture: CaretCapture | null;
  prevTopology: readonly LiveSectionRef[];
  nextTopology: readonly LiveSectionRef[];
  ydoc: Y.Doc;
  classify?: (capture: CaretCapture, ydoc: Y.Doc) => boolean;
}): CaretRecovery | null {
  const { capture, prevTopology, nextTopology, ydoc } = args;
  if (!capture) return null;
  if (sameTopologyIds(prevTopology, nextTopology)) return null;

  const sourceId = SectionId.brand(capture.sourceFragmentKey);
  const sourcePresent = nextTopology.some((r) => SectionId.equals(r.id, sourceId));
  const classify = args.classify ?? relSelResolvesInSource;

  if (sourcePresent && classify(capture, ydoc)) {
    return { kind: "survivor", sectionId: sourceId, fragmentKey: capture.sourceFragmentKey };
  }

  const prevIds = new Set(prevTopology.map((r) => r.id));
  const newRefs = nextTopology.filter((r) => !prevIds.has(r.id));
  if (newRefs.length === 0) {
    if (sourcePresent) {
      return { kind: "survivor", sectionId: sourceId, fragmentKey: capture.sourceFragmentKey };
    }
    return null;
  }

  const address = capture.promotedAddress;
  const ordinal = Math.max(
    0,
    Math.min(address?.headingOrdinalInPromoted ?? 0, newRefs.length - 1),
  );
  const target = newRefs[ordinal];
  return {
    kind: "retarget",
    sectionId: target.id,
    fragmentKey: SectionId.text(target.id),
    offsetInBlock: address?.offsetInBlock ?? 0,
    fingerprint: capture.fingerprint,
  };
}

function posAtTextOffset(doc: PmNode, textOffset: number): number {
  if (textOffset <= 0) {
    let firstText = -1;
    doc.descendants((node, pos) => {
      if (firstText >= 0) return false;
      if (node.isText) {
        firstText = pos;
        return false;
      }
      return true;
    });
    return firstText >= 0 ? firstText : 0;
  }
  let acc = 0;
  let emitted = false;
  let result = -1;
  let lastTextEnd = 0;
  doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (node.isTextblock && emitted) {
      acc += 1;
    }
    if (node.isText) {
      const len = node.text?.length ?? 0;
      if (acc + len >= textOffset) {
        result = pos + Math.max(0, textOffset - acc);
        return false;
      }
      acc += len;
      emitted = true;
      lastTextEnd = pos + len;
      return false;
    }
    return true;
  });
  return result >= 0 ? result : lastTextEnd;
}

function startOfBodyPos(doc: PmNode): number {
  if (doc.childCount > 1 && doc.child(0).type.name === "heading") {
    return posBeforeChild(doc, 1) + 1;
  }
  return 1;
}

function fingerprintMatchesAt(doc: PmNode, pos: number, fingerprint: CaretFingerprint): boolean {
  const beforeNeedle = fingerprint.before.slice(-FINGERPRINT_MATCH_LENGTH);
  const afterNeedle = fingerprint.after.slice(0, FINGERPRINT_MATCH_LENGTH);
  const actualBefore = doc
    .textBetween(Math.max(0, pos - FINGERPRINT_RADIUS * 2), pos, "\n")
    .slice(-beforeNeedle.length || undefined);
  const actualAfter = doc
    .textBetween(pos, Math.min(doc.content.size, pos + FINGERPRINT_RADIUS * 2), "\n")
    .slice(0, afterNeedle.length);
  const beforeOk = beforeNeedle.length === 0 || actualBefore === beforeNeedle;
  const afterOk = afterNeedle.length === 0 || actualAfter === afterNeedle;
  return beforeOk && afterOk;
}

export function resolveRetargetPmPos(doc: PmNode, target: RetargetCaretPlacement): number {
  const candidate = posAtTextOffset(doc, target.offsetInBlock);
  if (fingerprintMatchesAt(doc, candidate, target.fingerprint)) return candidate;

  const beforeNeedle = target.fingerprint.before.slice(-FINGERPRINT_MATCH_LENGTH);
  const afterNeedle = target.fingerprint.after.slice(0, FINGERPRINT_MATCH_LENGTH);
  const needle = beforeNeedle + afterNeedle;
  if (needle.length >= FINGERPRINT_MIN_SEARCH_LENGTH) {
    const fullText = doc.textBetween(0, doc.content.size, "\n");
    const idx = fullText.indexOf(needle);
    if (idx >= 0) {
      return posAtTextOffset(doc, idx + beforeNeedle.length);
    }
  }
  return startOfBodyPos(doc);
}
