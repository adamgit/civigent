import { afterEach, describe, expect, it, vi } from "vitest";
import { commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { setCrdtEventHandler } from "../../ws/crdt-coordinator.js";

vi.mock("../../storage/proposal-repository.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../storage/proposal-repository.js")>();
  return {
    ...real,
    readProposal: vi.fn(),
    transitionToCommitting: vi.fn().mockResolvedValue(undefined),
    transitionToCommitted: vi.fn().mockResolvedValue(undefined),
    rollbackCommittingToDraft: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../storage/snapshot.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../storage/snapshot.js")>();
  return {
    ...real,
    isSnapshotGenerationEnabled: vi.fn().mockReturnValue(false),
    scheduleSnapshotRegeneration: vi.fn(),
  };
});

describe("Post-commit notify invariants", () => {
  afterEach(() => {
    setCrdtEventHandler(() => {});
    vi.restoreAllMocks();
  });

  it("does not emit websocket events from commit pipeline", async () => {
    const { readProposal, transitionToCommitting, transitionToCommitted } =
      await import("../../storage/proposal-repository.js");
    const { CanonicalStore } = await import("../../storage/canonical-store.js");

    vi.mocked(readProposal).mockResolvedValue({
      id: "test-prop-001",
      intent: "test intent",
      writer: { id: "writer-1", type: "human", displayName: "Writer One" },
      sections: [
        { doc_path: "/sample.md", heading_path: ["Overview"] },
        { doc_path: "/sample.md", heading_path: ["Timeline"] },
      ],
      created_at: new Date().toISOString(),
      status: "draft",
    });
    vi.mocked(transitionToCommitting).mockResolvedValue(undefined);
    vi.mocked(transitionToCommitted).mockResolvedValue(undefined);
    vi.spyOn(CanonicalStore.prototype, "absorbChangedSections").mockResolvedValue({
      commitSha: "deadbeef001",
      rewrittenDocumentPaths: ["/sample.md"],
      absorbedSectionRefs: [
        { docPath: "/sample.md", headingPath: ["Overview"] },
        { docPath: "/sample.md", headingPath: ["Timeline"] },
      ],
      changedSections: [
        { docPath: "/sample.md", headingPath: ["Overview"] },
        { docPath: "/sample.md", headingPath: ["Timeline"] },
      ],
    });

    const events: unknown[] = [];
    setCrdtEventHandler((event) => {
      events.push(event);
    });

    await commitProposalToCanonical("test-prop-001", {});

    expect(events).toHaveLength(0);
  });

  it("keeps restore-target commit metadata without any post-commit websocket branch", async () => {
    const { readProposal, transitionToCommitting, transitionToCommitted } =
      await import("../../storage/proposal-repository.js");
    const { CanonicalStore } = await import("../../storage/canonical-store.js");

    vi.mocked(readProposal).mockResolvedValue({
      id: "test-prop-002",
      intent: "restore",
      writer: { id: "admin", type: "human", displayName: "Admin" },
      sections: [{ doc_path: "/sample.md", heading_path: ["Overview"] }],
      created_at: new Date().toISOString(),
      status: "draft",
    });
    vi.mocked(transitionToCommitting).mockResolvedValue(undefined);
    vi.mocked(transitionToCommitted).mockResolvedValue(undefined);
    vi.spyOn(CanonicalStore.prototype, "absorbChangedSections").mockResolvedValue({
      commitSha: "deadbeef002",
      rewrittenDocumentPaths: ["/sample.md"],
      absorbedSectionRefs: [{ docPath: "/sample.md", headingPath: ["Overview"] }],
      changedSections: [{ docPath: "/sample.md", headingPath: ["Overview"] }],
    });

    const events: unknown[] = [];
    setCrdtEventHandler((event) => {
      events.push(event);
    });

    await commitProposalToCanonical("test-prop-002", {}, undefined, {
      restoreTargetSha: "abc1234",
    });

    expect(events).toHaveLength(0);
  });
});
