import { afterEach, describe, expect, it, vi } from "vitest";
import { commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { setCrdtEventHandler } from "../../ws/crdt-ws-coordinator.js";

vi.mock("../../storage/proposal-repository.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../storage/proposal-repository.js")>();
  return {
    ...real,
    readProposal: vi.fn(),
    readActiveProposal: vi.fn(),
    transitionToCommitting: vi.fn().mockResolvedValue(undefined),
    transitionToCommitted: vi.fn().mockResolvedValue(undefined),
    rollbackCommittingProposal: vi.fn().mockResolvedValue(undefined),
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
    const { readActiveProposal, transitionToCommitting, transitionToCommitted } =
      await import("../../storage/proposal-repository.js");
    const { CanonicalStore } = await import("../../storage/canonical-store.js");

    vi.mocked(readActiveProposal).mockResolvedValue({
      id: "test-prop-001",
      intent: "test intent",
      writer: { id: "writer-1", type: "human", displayName: "Writer One" },
      sections: [
        { doc_path: "/sample.md", heading_path: ["Overview"] },
        { doc_path: "/sample.md", heading_path: ["Timeline"] },
      ],
      targets: [
        { kind: "section", doc_path: "/sample.md", heading_path: ["Overview"] },
        { kind: "section", doc_path: "/sample.md", heading_path: ["Timeline"] },
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

    // The commit pipeline neither emits WS events nor reinjects into live Y.Docs.
    // Canonical→live propagation is the CRDTProposalGenerator's Y.transact
    // primitive (Area B/H), driven off the committed canonical state — NOT a
    // pipeline reinjection path and NOT a field on AbsorbResult.
    expect(events).toHaveLength(0);
  });

  it("keeps restore-target commit metadata without any post-commit websocket branch", async () => {
    const { readActiveProposal, transitionToCommitting, transitionToCommitted } =
      await import("../../storage/proposal-repository.js");
    const { CanonicalStore } = await import("../../storage/canonical-store.js");

    vi.mocked(readActiveProposal).mockResolvedValue({
      id: "test-prop-002",
      intent: "restore",
      writer: { id: "admin", type: "human", displayName: "Admin" },
      sections: [{ doc_path: "/sample.md", heading_path: ["Overview"] }],
      targets: [{ kind: "section", doc_path: "/sample.md", heading_path: ["Overview"] }],
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
