import { describe, it, expect } from "vitest";
import { computeLayerWinner } from "../../diagnostics/document-diagnostics/collect-section-layers.js";

const PRESENT = { exists: true };
const ABSENT = { exists: false };

describe("computeLayerWinner", () => {
  it("no layer present → none", () => {
    expect(
      computeLayerWinner({
        canonical: ABSENT,
        overlay: ABSENT,
        fragment: ABSENT,
        crdt: ABSENT,
      }),
    ).toBe("none");
  });

  it("canonical-only → canonical", () => {
    expect(
      computeLayerWinner({
        canonical: PRESENT,
        overlay: ABSENT,
        fragment: ABSENT,
        crdt: ABSENT,
      }),
    ).toBe("canonical");
  });

  it("overlay shadows canonical", () => {
    expect(
      computeLayerWinner({
        canonical: PRESENT,
        overlay: PRESENT,
        fragment: ABSENT,
        crdt: ABSENT,
      }),
    ).toBe("overlay");
  });

  it("fragment shadows overlay and canonical", () => {
    expect(
      computeLayerWinner({
        canonical: PRESENT,
        overlay: PRESENT,
        fragment: PRESENT,
        crdt: ABSENT,
      }),
    ).toBe("fragment");
  });

  it("fragment-only (canonical + overlay missing) → fragment", () => {
    expect(
      computeLayerWinner({
        canonical: ABSENT,
        overlay: ABSENT,
        fragment: PRESENT,
        crdt: ABSENT,
      }),
    ).toBe("fragment");
  });

  it("crdt shadows fragment", () => {
    expect(
      computeLayerWinner({
        canonical: ABSENT,
        overlay: ABSENT,
        fragment: PRESENT,
        crdt: PRESENT,
      }),
    ).toBe("crdt");
  });

  it("crdt shadows all lower layers when every layer is present", () => {
    expect(
      computeLayerWinner({
        canonical: PRESENT,
        overlay: PRESENT,
        fragment: PRESENT,
        crdt: PRESENT,
      }),
    ).toBe("crdt");
  });
});
