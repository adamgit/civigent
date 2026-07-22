import { describe, it, expect } from "vitest";
import {
  resolveSectionAttributionState,
  SECTION_ATTRIBUTION_META,
  type SectionAttributionInput,
  type SectionAttributionState,
} from "../../services/section-attribution-state";

const ALL_STATES: SectionAttributionState[] = [
  "liveEditing",
  "draftPending",
  "recentlyEdited",
  "settled",
  "unknownWriter",
];

function input(partial: Partial<SectionAttributionInput> = {}): SectionAttributionInput {
  return {
    activeEditorIds: [],
    secondsAgo: undefined,
    pending: false,
    writerType: "human",
    ...partial,
  };
}

describe("resolveSectionAttributionState", () => {
  it("fires liveEditing only when a live editor is present", () => {
    expect(resolveSectionAttributionState(input({ activeEditorIds: ["u1"] }))).toBe("liveEditing");
  });

  it("does NOT fire liveEditing from a small secondsAgo (freshness is not liveness)", () => {
    expect(resolveSectionAttributionState(input({ activeEditorIds: [], secondsAgo: 5 }))).toBe("recentlyEdited");
  });

  it("live editor wins over pending, age, and writer type", () => {
    expect(
      resolveSectionAttributionState(input({ activeEditorIds: ["u1"], pending: true, secondsAgo: 3, writerType: "???" })),
    ).toBe("liveEditing");
  });

  it("fires draftPending from the pending flag when no live editor", () => {
    expect(resolveSectionAttributionState(input({ pending: true }))).toBe("draftPending");
  });

  it("draftPending wins over the age path and an unknown writer type", () => {
    expect(resolveSectionAttributionState(input({ pending: true, secondsAgo: 10, writerType: "???" }))).toBe("draftPending");
  });

  it("fails loud on an unrecognised writer type", () => {
    expect(resolveSectionAttributionState(input({ writerType: "robot" }))).toBe("unknownWriter");
  });

  it("treats a MISSING writer type as absent attribution, not an error (settled / age), so a structural-only edit never sticks on UNKNOWN", () => {
    expect(resolveSectionAttributionState(input({ writerType: undefined }))).toBe("settled");
    expect(resolveSectionAttributionState(input({ writerType: undefined, secondsAgo: 30 }))).toBe("recentlyEdited");
  });

  it("recognises both human and agent writer types", () => {
    expect(resolveSectionAttributionState(input({ writerType: "human", secondsAgo: 42 }))).toBe("recentlyEdited");
    expect(resolveSectionAttributionState(input({ writerType: "agent", secondsAgo: 42 }))).toBe("recentlyEdited");
  });

  it("fires recentlyEdited for a known writer with a fresh age", () => {
    expect(resolveSectionAttributionState(input({ secondsAgo: 120 }))).toBe("recentlyEdited");
  });

  it("fires settled for a known writer with no live authority, no pending, and no age", () => {
    expect(resolveSectionAttributionState(input({ secondsAgo: undefined }))).toBe("settled");
  });
});

describe("SECTION_ATTRIBUTION_META", () => {
  it("has a non-empty label for every attribution state", () => {
    for (const state of ALL_STATES) {
      expect(SECTION_ATTRIBUTION_META[state]).toBeDefined();
      expect(SECTION_ATTRIBUTION_META[state].label.length).toBeGreaterThan(0);
    }
  });

  it("has an entry for every resolvable state and no extras", () => {
    expect(Object.keys(SECTION_ATTRIBUTION_META).sort()).toEqual([...ALL_STATES].sort());
  });

  it("keeps liveEditing and recentlyEdited labels distinct so the age path can never claim liveness", () => {
    expect(SECTION_ATTRIBUTION_META.liveEditing.label).not.toBe(SECTION_ATTRIBUTION_META.recentlyEdited.label);
  });

  it("uses end-user draft wording", () => {
    expect(SECTION_ATTRIBUTION_META.draftPending.label).toBe("Draft edits here");
  });
});
