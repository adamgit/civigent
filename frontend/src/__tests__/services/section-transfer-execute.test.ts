/**
 * MW-10: SectionTransferService.execute() issues a backend-owned cross-section
 * move request (it is NO LONGER the "not available in this editor build" stub).
 *
 *  - a clean drop issues `sendSectionMove(source→target, before)` and resolves
 *    success once the provider's promise resolves (server applied + fanned out);
 *  - gating still denies with PROSE (no code) and does NOT issue a move when the
 *    transport is unavailable, the target is FSM-locked, or the target is in a
 *    CRDT block-state.
 *
 * Fails if execute() reverts to the unsupported stub: no `sendSectionMove` call
 * would be made and a clean drop would return `success: false`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SectionTransferService,
  type SectionInfo,
  type SectionTransfer,
} from "../../services/section-transfer";
import type { CrdtProvider } from "../../services/crdt-provider";

function makeTransfer(overrides: Partial<SectionTransfer> = {}): SectionTransfer {
  return {
    sourceFragmentKey: "section::timeline",
    sourceHeadingPath: ["Timeline"],
    targetFragmentKey: "section::overview",
    targetHeadingPath: ["Overview"],
    content: { markdown: "", plainText: "" },
    sourceSliceRange: null,
    deleteFromSource: true,
    ...overrides,
  };
}

function makeService(opts: {
  state?: string;
  sections?: SectionInfo[];
  sendSectionMove?: ReturnType<typeof vi.fn>;
}) {
  const sendSectionMove = opts.sendSectionMove ?? vi.fn().mockResolvedValue(undefined);
  const crdtProvider = {
    state: opts.state ?? "connected",
    sendSectionMove,
  } as unknown as CrdtProvider;
  const service = new SectionTransferService({
    crdtProvider,
    getSections: () => opts.sections ?? [
      { heading_path: ["Overview"], fragment_key: "section::overview" },
      { heading_path: ["Timeline"], fragment_key: "section::timeline" },
    ],
  });
  return { service, sendSectionMove };
}

describe("MW-10: SectionTransferService.execute() issues a backend move", () => {
  it("issues sendSectionMove(before) for a clean drop and resolves success", async () => {
    const { service, sendSectionMove } = makeService({});

    const result = await service.execute(makeTransfer());

    expect(sendSectionMove).toHaveBeenCalledTimes(1);
    expect(sendSectionMove).toHaveBeenCalledWith({
      sourceHeadingPath: ["Timeline"],
      targetHeadingPath: ["Overview"],
      position: "before",
    });
    expect(result.success).toBe(true);
    // It is NOT the removed "not available" stub (success carries no error).
    expect(result.error).toBeUndefined();
  });

  it("does NOT issue a move and denies with prose when the transport is unavailable", async () => {
    const { service, sendSectionMove } = makeService({ state: "reconnecting" });

    const result = await service.execute(makeTransfer());

    expect(sendSectionMove).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disconnected/i);
  });

  it("does NOT issue a move and denies with prose when the target is FSM-locked", async () => {
    const { service, sendSectionMove } = makeService({
      sections: [
        { heading_path: ["Overview"], fragment_key: "section::overview", locked: true },
        { heading_path: ["Timeline"], fragment_key: "section::timeline" },
      ],
    });

    const result = await service.execute(makeTransfer());

    expect(sendSectionMove).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/locked by an in-progress proposal/i);
    // Prose, never a bare code.
    expect(result.error).not.toMatch(/^[A-Z_]+$/);
  });

  it("does NOT issue a move and denies with prose when the target is in a CRDT block-state", async () => {
    const { service, sendSectionMove } = makeService({
      sections: [
        { heading_path: ["Overview"], fragment_key: "section::overview", blockState: true },
        { heading_path: ["Timeline"], fragment_key: "section::timeline" },
      ],
    });

    const result = await service.execute(makeTransfer());

    expect(sendSectionMove).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/temporarily unavailable/i);
  });

  it("surfaces the provider's prose error when the server move fails", async () => {
    const sendSectionMove = vi.fn().mockRejectedValue(new Error("Section move timed out — the server did not apply it."));
    const { service } = makeService({ sendSectionMove });

    const result = await service.execute(makeTransfer());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });
});
