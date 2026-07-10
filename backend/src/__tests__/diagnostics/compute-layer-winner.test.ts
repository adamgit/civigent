import { describe, it, expect } from "vitest";
import { computeLayerWinner } from "../../diagnostics/document-diagnostics/collect-section-layers.js";

const PRESENT = { exists: true };
const ABSENT = { exists: false };

// Layer precedence (lowest -> highest freshness):
//   canonical -> proposal (inprogress) -> crdt (live)
// The proposal rung is the durable saved state a refreshed client reconstructs
// from; the crdt rung wins over both when a live session exists.
describe("computeLayerWinner", () => {
  it("no layer present → none", () => {
    expect(computeLayerWinner({ canonical: ABSENT, proposal: ABSENT, crdt: ABSENT })).toBe("none");
  });

  it("canonical-only → canonical", () => {
    expect(computeLayerWinner({ canonical: PRESENT, proposal: ABSENT, crdt: ABSENT })).toBe("canonical");
  });

  it("proposal shadows canonical (durable saved state wins over stale canonical)", () => {
    expect(computeLayerWinner({ canonical: PRESENT, proposal: PRESENT, crdt: ABSENT })).toBe("proposal");
  });

  it("proposal-only (canonical missing) → proposal", () => {
    expect(computeLayerWinner({ canonical: ABSENT, proposal: PRESENT, crdt: ABSENT })).toBe("proposal");
  });

  it("crdt shadows both canonical and proposal", () => {
    expect(computeLayerWinner({ canonical: PRESENT, proposal: PRESENT, crdt: PRESENT })).toBe("crdt");
  });

  it("crdt-only (both canonical and proposal missing) → crdt", () => {
    expect(computeLayerWinner({ canonical: ABSENT, proposal: ABSENT, crdt: PRESENT })).toBe("crdt");
  });

  it("proposal parameter is optional — legacy callers without it still resolve canonical vs crdt", () => {
    expect(computeLayerWinner({ canonical: PRESENT, crdt: ABSENT })).toBe("canonical");
    expect(computeLayerWinner({ canonical: PRESENT, crdt: PRESENT })).toBe("crdt");
  });
});
