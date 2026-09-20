/**
 * Locate / plan / place across split shapes:
 *  - locateCaretInSplit (split boundary, heading ordinal, slot-local offset)
 *  - planCaretAfterSplit: stay on kept-prefix, follow-promotion on promoted,
 *    BFH dissolve follows, multi-seed maps by ordinal, merge defers to
 *    removal-handoff
 *  - pmPosForPlacement: slot-local offset, fingerprint slide inside the slot,
 *    first-body-block fallback
 */

import { describe, it, expect } from "vitest";
import { Schema, type Node as PmNode } from "@milkdown/prose/model";
import {
  splitBoundaryChildIndex,
  captureFingerprint,
  locateCaretInSplit,
  planCaretAfterSplit,
  pmPosForPlacement,
  ensureBodyBlock,
  type CaretCapture,
} from "../../pages/split-caret";
import {
  SectionId,
  BEFORE_FIRST_HEADING_SECTION_ID,
  type LiveSectionRef,
} from "../../types/live-sections";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    text: { group: "inline" },
  },
});

function heading(level: number, text: string): PmNode {
  return schema.node("heading", { level }, text ? [schema.text(text)] : []);
}
function para(text: string): PmNode {
  return schema.node("paragraph", null, text ? [schema.text(text)] : []);
}
function doc(...children: PmNode[]): PmNode {
  return schema.node("doc", null, children);
}

function posInChild(d: PmNode, childIndex: number, offset: number): number {
  let pos = 0;
  for (let i = 0; i < childIndex; i++) pos += d.child(i).nodeSize;
  return pos + 1 + offset;
}

const ref = (key: string, headingPath: string[]): LiveSectionRef => ({
  id: SectionId.brand(key),
  headingPath,
});
const BFH_REF = ref(SectionId.text(BEFORE_FIRST_HEADING_SECTION_ID), []);
const SURVIVOR = ref("section::overview", ["Overview"]);
const OTHER = ref("section::timeline", ["Timeline"]);
const PROMOTED_1 = ref("section::second", ["Second"]);
const PROMOTED_2 = ref("section::third", ["Third"]);

function makeCapture(overrides: Partial<CaretCapture>): CaretCapture {
  return {
    sourceFragmentKey: SectionId.text(SURVIVOR.id),
    location: { kind: "kept-prefix" },
    fingerprint: { before: "", after: "" },
    ...overrides,
  };
}

function planFrom(capture: CaretCapture, prev: readonly LiveSectionRef[], next: readonly LiveSectionRef[]) {
  return planCaretAfterSplit({
    location: capture.location,
    sourceFragmentKey: capture.sourceFragmentKey,
    fingerprint: capture.fingerprint,
    prevTopology: prev,
    nextTopology: next,
  });
}

describe("promoted-address math", () => {
  const survivorDoc = doc(
    heading(2, "Overview"),
    para("base body"),
    heading(2, "Second"),
    para("promoted body"),
  );

  it("split boundary is the 2nd heading for a headed section, the 1st for BFH", () => {
    expect(splitBoundaryChildIndex(survivorDoc, false)).toBe(2);
    const bfhDoc = doc(para("preamble"), heading(2, "h3 added"), para("pbody"));
    expect(splitBoundaryChildIndex(bfhDoc, true)).toBe(1);
    expect(splitBoundaryChildIndex(doc(heading(2, "Only"), para("body")), false)).toBeNull();
  });

  it("caret before the boundary → kept-prefix", () => {
    const caret = posInChild(survivorDoc, 1, 4);
    expect(locateCaretInSplit(survivorDoc, caret, false)).toEqual({ kind: "kept-prefix" });
  });

  it("caret in the promoted body → ordinal 0, body slot, offset from the body start", () => {
    const caret = posInChild(survivorDoc, 3, 9);
    expect(locateCaretInSplit(survivorDoc, caret, false)).toEqual({
      kind: "promoted",
      headingOrdinal: 0,
      slot: "body",
      offset: "promoted ".length,
    });
  });

  it("multi-seed: caret in the SECOND promoted block maps to ordinal 1", () => {
    const multi = doc(
      heading(2, "Overview"),
      para("base"),
      heading(2, "Second"),
      para("second body"),
      heading(2, "Third"),
      para("third body"),
    );
    const caret = posInChild(multi, 5, 6);
    expect(locateCaretInSplit(multi, caret, false)).toEqual({
      kind: "promoted",
      headingOrdinal: 1,
      slot: "body",
      offset: "third ".length,
    });
  });

  it("BFH root-split: caret in the promoted region addresses from the 1st heading", () => {
    const bfhDoc = doc(para("adding texxt"), heading(2, "h3 added"), para("promoted body"));
    const caret = posInChild(bfhDoc, 2, 9);
    expect(locateCaretInSplit(bfhDoc, caret, true)).toEqual({
      kind: "promoted",
      headingOrdinal: 0,
      slot: "body",
      offset: "promoted ".length,
    });
  });
});

describe("planCaretAfterSplit", () => {
  it("returns null when the topology is unchanged (content-only frame)", () => {
    expect(planFrom(makeCapture({}), [SURVIVOR, OTHER], [SURVIVOR, OTHER])).toBeNull();
  });

  it("kept-prefix caret → stay; y-prosemirror restore stands", () => {
    expect(planFrom(makeCapture({}), [SURVIVOR, OTHER], [SURVIVOR, PROMOTED_1, OTHER])).toEqual({
      action: "stay",
      sectionId: SURVIVOR.id,
      fragmentKey: SectionId.text(SURVIVOR.id),
    });
  });

  it("promoted caret → follow-promotion onto the new section with slot-local offset", () => {
    const capture = makeCapture({
      location: { kind: "promoted", headingOrdinal: 0, slot: "body", offset: 9 },
      fingerprint: { before: "promoted ", after: "body" },
    });
    expect(planFrom(capture, [SURVIVOR, OTHER], [SURVIVOR, PROMOTED_1, OTHER])).toEqual({
      action: "follow-promotion",
      sectionId: PROMOTED_1.id,
      fragmentKey: SectionId.text(PROMOTED_1.id),
      slot: "body",
      offset: 9,
      fingerprint: { before: "promoted ", after: "body" },
    });
  });

  it("multi-seed split maps by headingOrdinal, not 'always first new key'", () => {
    const capture = makeCapture({
      location: { kind: "promoted", headingOrdinal: 1, slot: "body", offset: 6 },
    });
    const plan = planFrom(capture, [SURVIVOR], [SURVIVOR, PROMOTED_1, PROMOTED_2]);
    expect(plan?.action).toBe("follow-promotion");
    expect(plan && "sectionId" in plan ? plan.sectionId : null).toBe(PROMOTED_2.id);
  });

  it("ordinal beyond the new-key count clamps to the last new section", () => {
    const capture = makeCapture({
      location: { kind: "promoted", headingOrdinal: 5, slot: "heading", offset: 0 },
    });
    const plan = planFrom(capture, [SURVIVOR], [SURVIVOR, PROMOTED_1]);
    expect(plan?.action).toBe("follow-promotion");
    expect(plan && "fragmentKey" in plan ? plan.fragmentKey : null).toBe(
      SectionId.text(PROMOTED_1.id),
    );
  });

  it("BFH dissolve: source gone → follow-promotion onto the promoted section", () => {
    const capture = makeCapture({
      sourceFragmentKey: SectionId.text(BFH_REF.id),
      location: { kind: "promoted", headingOrdinal: 0, slot: "body", offset: 4 },
    });
    const plan = planFrom(capture, [BFH_REF, OTHER], [PROMOTED_1, OTHER]);
    expect(plan?.action).toBe("follow-promotion");
    expect(plan && "sectionId" in plan ? plan.sectionId : null).toBe(PROMOTED_1.id);
  });

  it("source vanished with a kept-prefix location still follows onto the first new section", () => {
    const capture = makeCapture({
      sourceFragmentKey: SectionId.text(BFH_REF.id),
      location: { kind: "kept-prefix" },
    });
    const plan = planFrom(capture, [BFH_REF], [PROMOTED_1]);
    expect(plan).toEqual({
      action: "follow-promotion",
      sectionId: PROMOTED_1.id,
      fragmentKey: SectionId.text(PROMOTED_1.id),
      slot: "body",
      offset: 0,
      fingerprint: capture.fingerprint,
    });
  });

  it("merge/deletion (source gone, no new keys) defers to the removal-handoff rules", () => {
    expect(planFrom(makeCapture({}), [SURVIVOR, OTHER], [OTHER])).toBeNull();
  });

  it("source present, kept-prefix, no new keys → stay", () => {
    const plan = planFrom(makeCapture({}), [SURVIVOR, OTHER], [SURVIVOR]);
    expect(plan?.action).toBe("stay");
  });
});

describe("pmPosForPlacement", () => {
  const destDoc = doc(heading(2, "Second"), para("promoted body"));

  it("resolves the captured body-slot text offset against the destination doc", () => {
    const pos = pmPosForPlacement(destDoc, {
      slot: "body",
      offset: "promoted ".length,
      fingerprint: { before: "promoted ", after: "body" },
    });
    expect(pos).toBe(posInChild(destDoc, 1, 9));
  });

  it("fingerprint corrects a drifted offset (remint drift)", () => {
    const pos = pmPosForPlacement(destDoc, {
      slot: "body",
      offset: 2,
      fingerprint: { before: "promoted ", after: "body" },
    });
    expect(pos).toBe(posInChild(destDoc, 1, 9));
  });

  it("no offset match and no fingerprint match → start of destination body", () => {
    const pos = pmPosForPlacement(destDoc, {
      slot: "body",
      offset: 999,
      fingerprint: { before: "text that exists nowhere", after: "in this document at all" },
    });
    expect(pos).toBe(posInChild(destDoc, 1, 0));
  });

  it("heading slot offset 0 lands at the start of the heading text", () => {
    const pos = pmPosForPlacement(destDoc, {
      slot: "heading",
      offset: 0,
      fingerprint: { before: "", after: "" },
    });
    expect(pos).toBe(posInChild(destDoc, 0, 0));
  });
});

/**
 * Desired behavior of the live locate→place / recover pipeline.
 * Pointed at locateCaretInSplit / pmPosForPlacement / planCaretAfterSplit.
 * Canary 1 stays red until a body caret on a heading-only remint lands in a
 * paragraph (not the heading, and not a doc-end hack). Canary 2 is the RelPos
 * veto: a promoted location must follow-promotion even if RelPos would stay.
 */
describe("split-caret canaries", () => {
  it("# heading + Enter + heading-only remint does not place inside the heading", () => {
    const source = doc(
      heading(2, "Overview"),
      para("base body"),
      heading(2, "Second"),
      para(""),
    );
    const caret = posInChild(source, 3, 0);
    const location = locateCaretInSplit(source, caret, false);
    expect(location.kind).toBe("promoted");
    if (location.kind !== "promoted") return;
    expect(location.slot).toBe("body");
    const dest = ensureBodyBlock(doc(heading(2, "Second")));
    const pos = pmPosForPlacement(dest, {
      slot: location.slot,
      offset: location.offset,
      fingerprint: captureFingerprint(source, caret),
    });
    const clamped = Math.max(0, Math.min(pos, dest.content.size));
    const $pos = dest.resolve(clamped);
    expect($pos.parent.type.name).toBe("paragraph");
  });

  it("promoted caret retargets even when RelPos still resolves", () => {
    const plan = planCaretAfterSplit({
      location: { kind: "promoted", headingOrdinal: 0, slot: "body", offset: 16 },
      sourceFragmentKey: SectionId.text(SURVIVOR.id),
      fingerprint: { before: "", after: "" },
      prevTopology: [SURVIVOR, OTHER],
      nextTopology: [SURVIVOR, PROMOTED_1, OTHER],
    });
    expect(plan?.action).toBe("follow-promotion");
    expect(plan && "sectionId" in plan ? plan.sectionId : null).toBe(PROMOTED_1.id);
  });

  it("insert-before at the start of heading two follows the new section, not stay", () => {
    const headingTwo = ref("section::heading-two", ["heading two"]);
    const heading15 = ref("section::heading-1-5", ["heading 1.5"]);
    const source = doc(
      heading(2, "heading 1.5"),
      para("body 1.5"),
      heading(2, "heading two"),
      para("body two"),
    );
    const caret = posInChild(source, 1, "body 1.5".length);
    const location = locateCaretInSplit(source, caret, false, {
      heading: "heading two",
      headingLevel: 2,
    });
    expect(location).toEqual({
      kind: "promoted",
      headingOrdinal: 0,
      slot: "body",
      offset: "body 1.5".length,
    });
    const plan = planCaretAfterSplit({
      location,
      sourceFragmentKey: SectionId.text(headingTwo.id),
      fingerprint: { before: "", after: "" },
      prevTopology: [headingTwo],
      nextTopology: [heading15, headingTwo],
    });
    expect(plan?.action).toBe("follow-promotion");
    expect(plan && "sectionId" in plan ? plan.sectionId : null).toBe(heading15.id);
  });
});
