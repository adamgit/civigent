import { describe, it, expect } from "vitest";
import { decodeProposal } from "../../storage/proposal-file-decoder.js";

/**
 * Backward-compatibility: committed proposals written before the `targets` field
 * existed have a `meta.json` with `sections` but no `targets` key. Decoding such a
 * file must not throw — `/api/activity` reads committed proposals and a single
 * legacy file used to 500 the whole feed. Targets are derived from `sections`
 * (their only possible claims). A PRESENT-but-malformed `targets` must still throw.
 *
 * The `degraded` quarantine marker is status-aware: a COMMITTED/WITHDRAWN proposal
 * is terminal (it can never lock or commit again), so tagging it would be pure
 * noise — it decodes with usable display targets and NO marker. Only non-terminal
 * statuses (draft/pending/inprogress/committing) carry the marker.
 */

const LEGACY_COMMITTED_META = {
  id: "prop-legacy",
  writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
  intent: "legacy commit",
  sections: [{ doc_path: "/notes.md", heading_path: ["Overview"] }],
  // NOTE: no `targets` key — this is the legacy shape.
  created_at: "2025-01-01T00:00:00.000Z",
  committed_head: "abc123",
  humanInvolvement_at_commit: {},
};

describe("legacy committed proposal without targets", () => {
  it("decodes by deriving section targets from sections", () => {
    const decoded = decodeProposal(LEGACY_COMMITTED_META, "committed");
    expect(decoded.targets).toEqual([
      { kind: "section", doc_path: "/notes.md", heading_path: ["Overview"] },
    ]);
    expect(decoded.sections).toEqual([{ doc_path: "/notes.md", heading_path: ["Overview"] }]);
  });

  it("does NOT tag a terminal (committed) legacy proposal degraded — terminal is never quarantined", () => {
    const decoded = decodeProposal(LEGACY_COMMITTED_META, "committed");
    expect(decoded.degraded).toBeUndefined();
  });

  it("does NOT tag a terminal (withdrawn) legacy proposal degraded", () => {
    const decoded = decodeProposal(LEGACY_COMMITTED_META, "withdrawn");
    expect(decoded.degraded).toBeUndefined();
    // …but still derives display targets leniently.
    expect(decoded.targets.length).toBeGreaterThan(0);
  });

  it("DOES tag a non-terminal (draft) legacy proposal degraded ['missing-targets']", () => {
    const decoded = decodeProposal(LEGACY_COMMITTED_META, "draft");
    expect(decoded.degraded).toEqual(["missing-targets"]);
  });

  it("a healthy proposal (with a targets key) carries no degraded marker", () => {
    const healthy = decodeProposal(
      {
        ...LEGACY_COMMITTED_META,
        targets: [{ kind: "section", doc_path: "/notes.md", heading_path: ["Overview"] }],
      },
      "committed",
    );
    expect(healthy.degraded).toBeUndefined();
  });

  it("still throws when targets is present but malformed", () => {
    expect(() =>
      decodeProposal({ ...LEGACY_COMMITTED_META, targets: "not-an-array" }, "committed"),
    ).toThrow(/targets/);
  });
});

/**
 * `empty-committed` is a decoded domain-state invariant (committed + zero sections
 * + zero targets), NOT a raw-JSON-shape check. It must fire regardless of how the
 * empty target set arrived on disk: absent key, explicit `[]`, or written by a
 * prior bad implementation.
 */
describe("empty-committed classification from decoded domain state", () => {
  const EMPTY_COMMITTED_BASE = {
    id: "prop-empty",
    writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
    intent: "empty commit",
    sections: [],
    created_at: "2025-01-01T00:00:00.000Z",
    committed_head: "abc123",
    humanInvolvement_at_commit: {},
  };

  it("tags empty-committed when the targets key is absent (derives to [])", () => {
    const decoded = decodeProposal(EMPTY_COMMITTED_BASE, "committed");
    expect(decoded.degraded).toEqual(["empty-committed"]);
  });

  it("tags empty-committed when targets is explicitly [] (not a missing key)", () => {
    const decoded = decodeProposal({ ...EMPTY_COMMITTED_BASE, targets: [] }, "committed");
    expect(decoded.degraded).toEqual(["empty-committed"]);
  });

  it("does NOT tag empty-committed for a non-committed zero-claim proposal", () => {
    // A non-terminal empty proposal is missing-targets territory (via absent key),
    // never empty-committed.
    const decoded = decodeProposal(EMPTY_COMMITTED_BASE, "draft");
    expect(decoded.degraded).toEqual(["missing-targets"]);
  });

  it("does NOT tag empty-committed when the committed proposal still has section targets", () => {
    const decoded = decodeProposal(
      {
        ...EMPTY_COMMITTED_BASE,
        sections: [{ doc_path: "/notes.md", heading_path: ["Overview"] }],
        targets: [{ kind: "section", doc_path: "/notes.md", heading_path: ["Overview"] }],
      },
      "committed",
    );
    expect(decoded.degraded).toBeUndefined();
  });
});
