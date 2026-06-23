/**
 * Commit-description synthesis (spec 10 §15 "Commit-description synthesis").
 *
 * The description is synthesized from the proposal's FINAL changed section-set
 * (and any inferred narrative), NOT guessed from early raw activity. When no
 * confident preferred narrative is available, the fallback is still honest and
 * conservative: it names the touched sections and observed structural operations.
 *
 * These assert the description is DERIVED from the changed set (different sets →
 * different descriptions), never a vague constant.
 */

import { describe, it, expect } from "vitest";
import {
  synthesizeCommitDescription,
  type StructuralOpKind,
} from "../../storage/commit-description.js";

describe("synthesizeCommitDescription (spec 10 §Commit-description synthesis)", () => {
  it("names a single changed section", () => {
    expect(synthesizeCommitDescription({ changedSections: [{ headingPath: ["Overview"] }] })).toBe(
      "Update Overview",
    );
  });

  it("names a nested section by its heading path", () => {
    expect(
      synthesizeCommitDescription({ changedSections: [{ headingPath: ["Overview", "Goals"] }] }),
    ).toBe("Update Overview › Goals");
  });

  it("names the before-first-heading section as the document preamble", () => {
    expect(synthesizeCommitDescription({ changedSections: [{ headingPath: [] }] })).toBe(
      "Update the document preamble",
    );
  });

  it("lists multiple changed sections (derived from the final set, not a constant)", () => {
    const desc = synthesizeCommitDescription({
      changedSections: [{ headingPath: ["Overview"] }, { headingPath: ["Timeline"] }],
    });
    expect(desc).toBe("Update 2 sections (Overview and Timeline)");
    // Different set → different description (proves derivation).
    const other = synthesizeCommitDescription({
      changedSections: [{ headingPath: ["Budget"] }],
    });
    expect(other).toBe("Update Budget");
    expect(other).not.toBe(desc);
  });

  it("describes a structural refactor by naming the observed operation kinds", () => {
    const ops: StructuralOpKind[] = ["split", "merge"];
    expect(
      synthesizeCommitDescription({
        changedSections: [{ headingPath: ["Overview"] }],
        structuralOps: ops,
      }),
    ).toBe("Reorganize Overview, including section splits and section merges");
  });

  it("dedupes repeated structural-op kinds", () => {
    expect(
      synthesizeCommitDescription({
        changedSections: [{ headingPath: ["Overview"] }],
        structuralOps: ["rename", "rename"],
      }),
    ).toBe("Reorganize Overview, including heading renames");
  });

  it("falls back conservatively for a document-level change with no sections", () => {
    expect(synthesizeCommitDescription({ changedSections: [] })).toBe(
      "Document-level change with no section content edits",
    );
    expect(
      synthesizeCommitDescription({ changedSections: [], structuralOps: ["move"] }),
    ).toBe("Document-level change including section moves");
  });

  it("uses the preferred narrative when one is confidently available", () => {
    expect(
      synthesizeCommitDescription({
        changedSections: [{ headingPath: ["Overview"] }],
        preferredNarrative: () => "Add or expand the subtree around Overview",
      }),
    ).toBe("Add or expand the subtree around Overview");
  });

  it("falls back to the conservative description when narrative synthesis FAILS (returns null)", () => {
    const desc = synthesizeCommitDescription({
      changedSections: [{ headingPath: ["Overview"] }, { headingPath: ["Timeline"] }],
      structuralOps: ["rename"],
      preferredNarrative: () => null, // synthesis produced no confident narrative
    });
    // Honest + conservative: names the touched sections AND the structural op kind.
    expect(desc).toBe("Reorganize 2 sections (Overview and Timeline), including heading renames");
  });

  it("ignores an empty/whitespace narrative and uses the conservative fallback", () => {
    expect(
      synthesizeCommitDescription({
        changedSections: [{ headingPath: ["Overview"] }],
        preferredNarrative: () => "   ",
      }),
    ).toBe("Update Overview");
  });
});
