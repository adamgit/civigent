/**
 * Caret capture/recover across split shapes (fix-caret-loss):
 *  - promoted-address math (split boundary, heading ordinal, in-block offset)
 *  - recoverCaret classification: survivor untouched, promoted retargets,
 *    BFH dissolve retargets, multi-seed maps by ordinal, merge defers to
 *    removal-handoff, never silently stays on the survivor
 *  - resolveRetargetPmPos: offset resolution, fingerprint drift correction,
 *    start-of-body fallback
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { Schema, type Node as PmNode } from "@milkdown/prose/model";
import {
  computePromotedAddress,
  splitBoundaryChildIndex,
  captureFingerprint,
  recoverCaret,
  resolveRetargetPmPos,
  type CaretCapture,
} from "../../pages/caret-recovery";
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
    relSel: { type: "text", anchor: {}, head: {} },
    promotedAddress: null,
    fingerprint: { before: "", after: "" },
    binding: { type: new Y.Doc().getXmlFragment("x"), mapping: new Map() },
    ...overrides,
  };
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

  it("caret before the boundary → no promoted address (survivor region)", () => {
    const caret = posInChild(survivorDoc, 1, 4);
    expect(computePromotedAddress(survivorDoc, caret, false)).toBeNull();
  });

  it("caret in the promoted block → ordinal 0 and an in-block text offset", () => {
    const caret = posInChild(survivorDoc, 3, 9);
    const address = computePromotedAddress(survivorDoc, caret, false);
    expect(address).not.toBeNull();
    expect(address!.headingOrdinalInPromoted).toBe(0);
    expect(address!.offsetInBlock).toBe("Second\npromoted ".length);
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
    const address = computePromotedAddress(multi, caret, false);
    expect(address!.headingOrdinalInPromoted).toBe(1);
    expect(address!.offsetInBlock).toBe("Third\nthird ".length);
  });

  it("BFH root-split: caret in the promoted region addresses from the 1st heading", () => {
    const bfhDoc = doc(para("adding texxt"), heading(2, "h3 added"), para("promoted body"));
    const caret = posInChild(bfhDoc, 2, 9);
    const address = computePromotedAddress(bfhDoc, caret, true);
    expect(address!.headingOrdinalInPromoted).toBe(0);
    expect(address!.offsetInBlock).toBe("h3 added\npromoted ".length);
  });
});

describe("recoverCaret classification", () => {
  const ydoc = new Y.Doc();

  it("returns null when the topology is unchanged (content-only frame)", () => {
    const capture = makeCapture({});
    expect(
      recoverCaret({
        capture,
        prevTopology: [SURVIVOR, OTHER],
        nextTopology: [SURVIVOR, OTHER],
        ydoc,
        classify: () => true,
      }),
    ).toBeNull();
  });

  it("survivor-prefix caret (RelPos resolves) → survivor; y-prosemirror restore stands", () => {
    const capture = makeCapture({});
    const recovery = recoverCaret({
      capture,
      prevTopology: [SURVIVOR, OTHER],
      nextTopology: [SURVIVOR, PROMOTED_1, OTHER],
      ydoc,
      classify: () => true,
    });
    expect(recovery).toEqual({
      kind: "survivor",
      sectionId: SURVIVOR.id,
      fragmentKey: SectionId.text(SURVIVOR.id),
    });
  });

  it("promoted caret (RelPos dead) → retarget to the new section with the captured offset", () => {
    const capture = makeCapture({
      promotedAddress: { headingOrdinalInPromoted: 0, offsetInBlock: 16 },
      fingerprint: { before: "promoted ", after: "body" },
    });
    const recovery = recoverCaret({
      capture,
      prevTopology: [SURVIVOR, OTHER],
      nextTopology: [SURVIVOR, PROMOTED_1, OTHER],
      ydoc,
      classify: () => false,
    });
    expect(recovery).toEqual({
      kind: "retarget",
      sectionId: PROMOTED_1.id,
      fragmentKey: SectionId.text(PROMOTED_1.id),
      offsetInBlock: 16,
      fingerprint: { before: "promoted ", after: "body" },
    });
  });

  it("multi-seed split maps by headingOrdinalInPromoted, not 'always first new key'", () => {
    const capture = makeCapture({
      promotedAddress: { headingOrdinalInPromoted: 1, offsetInBlock: 12 },
    });
    const recovery = recoverCaret({
      capture,
      prevTopology: [SURVIVOR],
      nextTopology: [SURVIVOR, PROMOTED_1, PROMOTED_2],
      ydoc,
      classify: () => false,
    });
    expect(recovery?.kind).toBe("retarget");
    expect(recovery && "sectionId" in recovery ? recovery.sectionId : null).toBe(PROMOTED_2.id);
  });

  it("ordinal beyond the new-key count clamps to the last new section", () => {
    const capture = makeCapture({
      promotedAddress: { headingOrdinalInPromoted: 5, offsetInBlock: 0 },
    });
    const recovery = recoverCaret({
      capture,
      prevTopology: [SURVIVOR],
      nextTopology: [SURVIVOR, PROMOTED_1],
      ydoc,
      classify: () => false,
    });
    expect(recovery?.kind).toBe("retarget");
    expect(recovery && "fragmentKey" in recovery ? recovery.fragmentKey : null).toBe(
      SectionId.text(PROMOTED_1.id),
    );
  });

  it("BFH dissolve: source gone → retarget to the promoted section (never null-drop the caret)", () => {
    const capture = makeCapture({
      sourceFragmentKey: SectionId.text(BFH_REF.id),
      promotedAddress: { headingOrdinalInPromoted: 0, offsetInBlock: 4 },
    });
    const recovery = recoverCaret({
      capture,
      prevTopology: [BFH_REF, OTHER],
      nextTopology: [PROMOTED_1, OTHER],
      ydoc,
      classify: () => false,
    });
    expect(recovery?.kind).toBe("retarget");
    expect(recovery && "sectionId" in recovery ? recovery.sectionId : null).toBe(PROMOTED_1.id);
  });

  it("promoted caret with NO address still retargets (start of destination), never stays silently", () => {
    const capture = makeCapture({ promotedAddress: null });
    const recovery = recoverCaret({
      capture,
      prevTopology: [SURVIVOR],
      nextTopology: [SURVIVOR, PROMOTED_1],
      ydoc,
      classify: () => false,
    });
    expect(recovery).toEqual({
      kind: "retarget",
      sectionId: PROMOTED_1.id,
      fragmentKey: SectionId.text(PROMOTED_1.id),
      offsetInBlock: 0,
      fingerprint: capture.fingerprint,
    });
  });

  it("merge/deletion (source gone, no new keys) defers to the removal-handoff rules", () => {
    const capture = makeCapture({});
    expect(
      recoverCaret({
        capture,
        prevTopology: [SURVIVOR, OTHER],
        nextTopology: [OTHER],
        ydoc,
        classify: () => false,
      }),
    ).toBeNull();
  });

  it("source present, classify fails, no new keys → survivor focus (best remaining anchor)", () => {
    const capture = makeCapture({});
    const recovery = recoverCaret({
      capture,
      prevTopology: [SURVIVOR, OTHER],
      nextTopology: [SURVIVOR],
      ydoc,
      classify: () => false,
    });
    expect(recovery?.kind).toBe("survivor");
  });

  it("null capture → null (no focused editor at frame time)", () => {
    expect(
      recoverCaret({
        capture: null,
        prevTopology: [SURVIVOR],
        nextTopology: [SURVIVOR, PROMOTED_1],
        ydoc,
      }),
    ).toBeNull();
  });
});

describe("resolveRetargetPmPos", () => {
  const destDoc = doc(heading(2, "Second"), para("promoted body"));

  it("resolves the captured in-block text offset against the destination doc", () => {
    const fingerprint = captureFingerprint(destDoc, posInChild(destDoc, 1, 9));
    const pos = resolveRetargetPmPos(destDoc, {
      offsetInBlock: "Second\npromoted ".length,
      fingerprint,
    });
    expect(pos).toBe(posInChild(destDoc, 1, 9));
  });

  it("fingerprint corrects a drifted offset (remint drift)", () => {
    const targetPos = posInChild(destDoc, 1, 9);
    const fingerprint = captureFingerprint(destDoc, targetPos);
    const pos = resolveRetargetPmPos(destDoc, { offsetInBlock: 2, fingerprint });
    expect(pos).toBe(targetPos);
  });

  it("no offset match and no fingerprint match → start of destination body", () => {
    const pos = resolveRetargetPmPos(destDoc, {
      offsetInBlock: 999,
      fingerprint: { before: "text that exists nowhere", after: "in this document at all" },
    });
    expect(pos).toBe(posInChild(destDoc, 1, 0));
  });

  it("offset 0 lands at the start of the destination content", () => {
    const pos = resolveRetargetPmPos(destDoc, {
      offsetInBlock: 0,
      fingerprint: { before: "", after: "" },
    });
    expect(pos).toBe(posInChild(destDoc, 0, 0));
  });
});
