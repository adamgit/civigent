import { describe, it, expect } from "vitest";
import { TRANSPORT_STATUS_META } from "../../services/section-save-state";

describe("TRANSPORT_STATUS_META.savedToProposal", () => {
  it("uses the shortened 'Saved · Draft' label (Saved owns the green, Draft owns the pending-ness)", () => {
    expect(TRANSPORT_STATUS_META.savedToProposal.label).toBe("Saved · Draft");
  });

  it("keeps the lime dot (durable proposal save, not an amber warning)", () => {
    expect(TRANSPORT_STATUS_META.savedToProposal.dotClass).toBe("bg-lime-500");
  });
});
