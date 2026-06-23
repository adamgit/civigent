/**
 * Claim-review 03 / Option E: SectionTransferService.execute() drives the LIVE
 * cross-section move over the CONTROL-PLANE REST endpoint, NOT a CRDT binary frame.
 *
 *  - a clean drop awaits the ordering barrier, calls `apiClient.liveMoveSection`,
 *    and resolves success on the REST `200` (NOT on "any remote Y update");
 *  - a `409` refusal renders the backend's prose VERBATIM;
 *  - client gating still denies with PROSE (no code) and does NOT issue a move when
 *    the transport is unavailable, the target is FSM-locked, or the target is in a
 *    CRDT block-state;
 *  - execute() NEVER calls a (now-deleted) `sendSectionMove`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SectionTransferService,
  type SectionInfo,
  type SectionTransfer,
} from "../../services/section-transfer";
import type { CrdtTransport } from "../../services/crdt-transport";
import { apiClient } from "../../services/api-client";

vi.mock("../../services/api-client", () => ({
  apiClient: { liveMoveSection: vi.fn() },
}));

const liveMoveSection = apiClient.liveMoveSection as unknown as ReturnType<typeof vi.fn>;

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

const callOrder: string[] = [];

function makeService(opts: { state?: string; sections?: SectionInfo[] }) {
  const flushAndAwaitSync = vi.fn().mockImplementation(async () => { callOrder.push("flush"); });
  const onceRemoteUpdate = vi.fn();
  const sendSectionMove = vi.fn(); // must NEVER be called (method is deleted in prod)
  const transport = {
    state: opts.state ?? "connected",
    documentPath: "/ops/strategy.md",
    flushAndAwaitSync,
    onceRemoteUpdate,
    sendSectionMove,
  } as unknown as CrdtTransport & { sendSectionMove: ReturnType<typeof vi.fn> };
  const service = new SectionTransferService({
    transport,
    getSections: () => opts.sections ?? [
      { heading_path: ["Overview"], fragment_key: "section::overview" },
      { heading_path: ["Timeline"], fragment_key: "section::timeline" },
    ],
  });
  return { service, flushAndAwaitSync, onceRemoteUpdate, sendSectionMove };
}

describe("Option E: SectionTransferService.execute() drives a REST live move", () => {
  beforeEach(() => {
    liveMoveSection.mockReset();
    liveMoveSection.mockImplementation(async () => { callOrder.push("move"); return { ok: true }; });
    callOrder.length = 0;
  });

  it("flushes the barrier BEFORE the move, calls liveMoveSection(before), and resolves success on 200", async () => {
    const { service, flushAndAwaitSync, onceRemoteUpdate, sendSectionMove } = makeService({});

    const result = await service.execute(makeTransfer());

    // ORDERING BARRIER: the materialization flush MUST precede the move POST, or
    // the re-seed clobbers the requester's in-flight edits (claim-review 03).
    expect(callOrder).toEqual(["flush", "move"]);
    expect(flushAndAwaitSync).toHaveBeenCalledTimes(1);
    expect(liveMoveSection).toHaveBeenCalledTimes(1);
    expect(liveMoveSection).toHaveBeenCalledWith("/ops/strategy.md", {
      sourceHeadingPath: ["Timeline"],
      targetHeadingPath: ["Overview"],
      position: "before",
    });
    expect(sendSectionMove).not.toHaveBeenCalled(); // never the deleted binary path
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // Caret recovery is armed off the WS fan-out (no editor view here → still armed).
    expect(onceRemoteUpdate).not.toHaveBeenCalled(); // no captured caret without an editor view
  });

  it("renders the backend's 409 prose refusal verbatim", async () => {
    liveMoveSection.mockResolvedValue({ ok: false, message: "This document is being published right now — try moving the section again in a moment." });
    const { service } = makeService({});

    const result = await service.execute(makeTransfer());

    expect(result.success).toBe(false);
    expect(result.error).toBe("This document is being published right now — try moving the section again in a moment.");
  });

  it("does NOT issue a move and denies with prose when the transport is unavailable", async () => {
    const { service, sendSectionMove } = makeService({ state: "reconnecting" });

    const result = await service.execute(makeTransfer());

    expect(liveMoveSection).not.toHaveBeenCalled();
    expect(sendSectionMove).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disconnected/i);
  });

  it("does NOT issue a move and denies with prose when the target is FSM-locked", async () => {
    const { service } = makeService({
      sections: [
        { heading_path: ["Overview"], fragment_key: "section::overview", locked: true },
        { heading_path: ["Timeline"], fragment_key: "section::timeline" },
      ],
    });

    const result = await service.execute(makeTransfer());

    expect(liveMoveSection).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/locked by an in-progress proposal/i);
    expect(result.error).not.toMatch(/^[A-Z_]+$/);
  });

  it("does NOT issue a move and denies with prose when the target is in a CRDT block-state", async () => {
    const { service } = makeService({
      sections: [
        { heading_path: ["Overview"], fragment_key: "section::overview", blockState: true },
        { heading_path: ["Timeline"], fragment_key: "section::timeline" },
      ],
    });

    const result = await service.execute(makeTransfer());

    expect(liveMoveSection).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/temporarily unavailable/i);
  });
});
