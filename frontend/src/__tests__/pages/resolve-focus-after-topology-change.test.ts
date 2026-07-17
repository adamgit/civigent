/**
 * resolveFocusAfterTopologyChange — the complete removal-handoff rule.
 * Covers: present (keep), BFH-dissolve, no-predecessor→BFH / first-remaining,
 * predecessor-merge survivor, mid-slot fallback, null cases.
 */

import { describe, it, expect } from "vitest";
import { resolveFocusAfterTopologyChange } from "../../pages/resolve-focus-after-topology-change";
import { SectionId, BEFORE_FIRST_HEADING_SECTION_ID, type LiveSectionRef } from "../../types/live-sections";

const ref = (key: string, headingPath: string[]): LiveSectionRef => ({
  id: SectionId.brand(key),
  headingPath,
});
const BFH = ref("section::__beforeFirstHeading__", []);
const A = ref("section::a", ["A"]);
const B = ref("section::b", ["B"]);
const C = ref("section::c", ["C"]);

describe("resolveFocusAfterTopologyChange", () => {
  it("keeps focus when the id is still present (identity stable across moves)", () => {
    expect(resolveFocusAfterTopologyChange([A, B, C], [C, A, B], A.id)).toBe(A.id);
  });

  it("returns null when focusedId is null", () => {
    expect(resolveFocusAfterTopologyChange([A], [A], null)).toBeNull();
  });

  it("BFH dissolved → first headed section", () => {
    expect(resolveFocusAfterTopologyChange([BFH, A, B], [A, B], BEFORE_FIRST_HEADING_SECTION_ID)).toBe(A.id);
  });

  it("BFH dissolved with no headed section → null", () => {
    expect(resolveFocusAfterTopologyChange([BFH], [], BEFORE_FIRST_HEADING_SECTION_ID)).toBeNull();
  });

  it("first section removed, BFH created → focus BFH", () => {
    // A was index 0 with no predecessor; no-predecessor demotion created BFH.
    expect(resolveFocusAfterTopologyChange([A, B], [BFH, B], A.id)).toBe(BEFORE_FIRST_HEADING_SECTION_ID);
  });

  it("first section removed, no BFH → first remaining", () => {
    expect(resolveFocusAfterTopologyChange([A, B], [B], A.id)).toBe(B.id);
  });

  it("first section removed, nothing remains → null", () => {
    expect(resolveFocusAfterTopologyChange([A], [], A.id)).toBeNull();
  });

  it("non-first removed → predecessor survivor", () => {
    // B (index 1) merged into predecessor A.
    expect(resolveFocusAfterTopologyChange([A, B, C], [A, C], B.id)).toBe(A.id);
  });

  it("non-first removed, predecessor also gone → section now in that slot", () => {
    // B removed and its predecessor A also gone; slot index 1 now holds C.
    expect(resolveFocusAfterTopologyChange([A, B, C], [C], B.id)).toBe(C.id);
  });

  it("non-first removed, nothing remains → null", () => {
    expect(resolveFocusAfterTopologyChange([A, B], [], B.id)).toBeNull();
  });

  it("focused id absent from both prev and next → null", () => {
    expect(resolveFocusAfterTopologyChange([A], [A], SectionId.brand("section::ghost"))).toBeNull();
  });

  it("9: nested first-section demotion (parent removed, children reparented) → BFH or first remaining", () => {
    // Intro (first headed) demoted; Child/Grand were under Intro and are now
    // top-level; BFH holds the orphan body. Focus was on Intro → must land on BFH.
    const intro = ref("section::intro", ["Intro"]);
    const child = ref("section::child", ["Intro", "Child"]);
    const grand = ref("section::grand", ["Intro", "Child", "Grandchild"]);
    const childTop = ref("section::child", ["Child"]);
    const grandTop = ref("section::grand", ["Child", "Grandchild"]);

    expect(
      resolveFocusAfterTopologyChange(
        [intro, child, grand],
        [BFH, childTop, grandTop],
        intro.id,
      ),
    ).toBe(BEFORE_FIRST_HEADING_SECTION_ID);

    // Same demotion with empty orphan body (BFH dissolved) → first remaining (Child).
    expect(
      resolveFocusAfterTopologyChange(
        [intro, child, grand],
        [childTop, grandTop],
        intro.id,
      ),
    ).toBe(childTop.id);
  });
});

