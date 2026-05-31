import { describe, it, expect } from "vitest";
import { computeLayerWinner } from "../../diagnostics/document-diagnostics/collect-section-layers.js";

const PRESENT = { exists: true };
const ABSENT = { exists: false };

// Session overlay + raw-fragment disk layers are gone (Area D / spec 05). The
// only durable baseline is canonical; the only live layer is the CRDT Y.Doc.
describe("computeLayerWinner", () => {
  it("no layer present → none", () => {
    expect(computeLayerWinner({ canonical: ABSENT, crdt: ABSENT })).toBe("none");
  });

  it("canonical-only → canonical", () => {
    expect(computeLayerWinner({ canonical: PRESENT, crdt: ABSENT })).toBe("canonical");
  });

  it("crdt shadows canonical", () => {
    expect(computeLayerWinner({ canonical: PRESENT, crdt: PRESENT })).toBe("crdt");
  });

  it("crdt-only (canonical missing) → crdt", () => {
    expect(computeLayerWinner({ canonical: ABSENT, crdt: PRESENT })).toBe("crdt");
  });
});
