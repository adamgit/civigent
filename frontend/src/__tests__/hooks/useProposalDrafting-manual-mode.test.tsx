/**
 * Manual proposal mode (spec 11 §Manual Proposal Publication; spec 02 §3).
 *
 * The drafting flow must go through the real proposal APIs (not local component
 * state): start creates an EMPTY draft, selecting a section SAVES it via the
 * manifest + staged-content routes, lock acquisition surfaces the backend's
 * intent-required refusal, and once `inprogress` the section scope is FIXED
 * (further scope edits are refused).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { DocumentSection } from "../../pages/document-page-utils";

const api = vi.hoisted(() => ({
  submitProposal: vi.fn(),
  getProposal: vi.fn(),
  getProposalDocumentSections: vi.fn(),
  updateProposalManifest: vi.fn(),
  replaceProposalSections: vi.fn(),
  acquireLocks: vi.fn(),
}));

vi.mock("../../services/api-client", () => ({
  apiClient: api,
  resolveWriterId: () => "test-user",
}));

import { useProposalDrafting, type UseProposalDraftingParams } from "../../hooks/useProposalDrafting";

function section(headingPath: string[], content: string): DocumentSection {
  return {
    heading: headingPath[headingPath.length - 1] ?? "",
    heading_path: headingPath,
    depth: headingPath.length,
    content,
    agentWritePolicy: { canWrite: true, message: "ok" },
    crdt_session_active: false,
    section_length_warning: false,
    word_count: 2,
    fragment_key: `frag:${headingPath.join("/") || "root"}`,
    section_file: "f.md",
  };
}

function params(sections: DocumentSection[]): UseProposalDraftingParams {
  return {
    decodedDocPath: "test.md",
    sections,
    setError: vi.fn(),
    loadSections: vi.fn(async () => sections),
    setFocusedSectionIndex: vi.fn(),
    leaveLiveEditing: vi.fn(async () => {}),
  };
}

describe("manual proposal mode (spec 11)", () => {
  beforeEach(() => {
    api.submitProposal.mockClear().mockResolvedValue({ proposal_id: "p1" });
    api.getProposal.mockClear().mockResolvedValue({ proposal: { id: "p1", status: "draft", intent: "", sections: [] } });
    api.getProposalDocumentSections.mockClear().mockResolvedValue({ sections: [] });
    api.updateProposalManifest.mockClear().mockResolvedValue({});
    api.replaceProposalSections.mockClear().mockResolvedValue({});
    api.acquireLocks.mockClear().mockResolvedValue({ acquired: true, status: "inprogress" });
  });
  afterEach(() => vi.clearAllMocks());

  it("starts manual publish by creating an EMPTY draft", async () => {
    const overview = section(["Overview"], "Overview body.\n");
    const { result } = renderHook(() => useProposalDrafting(params([overview])));

    await act(async () => {
      await result.current.startManualPublish();
    });

    expect(api.submitProposal).toHaveBeenCalledWith({ intent: "", sections: [] });
    expect(result.current.proposalMode).toBe(true);
    expect(result.current.activeProposalStatus).toBe("draft");
  });

  it("selecting a section saves it through the manifest + staged-content routes", async () => {
    const overview = section(["Overview"], "Overview body.\n");
    const { result } = renderHook(() => useProposalDrafting(params([overview])));
    await act(async () => { await result.current.startManualPublish(); });

    await act(async () => {
      await result.current.toggleProposalSection(overview);
    });

    expect(api.updateProposalManifest).toHaveBeenCalledWith("p1", {
      intent: "",
      targets: [{ doc_path: "test.md", heading_path: ["Overview"] }],
    });
    expect(api.replaceProposalSections).toHaveBeenCalledWith("p1", {
      sections: [{ doc_path: "test.md", heading_path: ["Overview"], content: "Overview body.\n" }],
    });
  });

  it("surfaces the backend intent-required refusal on lock acquisition", async () => {
    api.acquireLocks.mockResolvedValueOnce({
      acquired: false,
      message: "Cannot acquire locks: intent is required before entering inprogress.",
    } as never);
    const { result } = renderHook(() => useProposalDrafting(params([])));
    await act(async () => { await result.current.startManualPublish(); });

    await act(async () => { await result.current.acquireProposalLocks(); });

    expect(api.acquireLocks).toHaveBeenCalledWith("p1");
    expect(result.current.panelError).toBe(
      "Cannot acquire locks: intent is required before entering inprogress.",
    );
  });

  it("removing the only selected draft section persists an empty scope (valid draft, not corruption)", async () => {
    const overview = section(["Overview"], "Overview body.\n");
    const { result } = renderHook(() => useProposalDrafting(params([overview])));

    // getProposal reflects the evolving draft scope across the enter/select/remove
    // refreshes: empty on enter, one section after select, empty again after remove.
    api.getProposal
      .mockResolvedValueOnce({ proposal: { id: "p1", status: "draft", intent: "", sections: [] } })
      .mockResolvedValueOnce({
        proposal: {
          id: "p1",
          status: "draft",
          intent: "",
          sections: [{ doc_path: "test.md", heading_path: ["Overview"], content: "Overview body.\n" }],
        },
      })
      .mockResolvedValue({ proposal: { id: "p1", status: "draft", intent: "", sections: [] } });

    await act(async () => { await result.current.startManualPublish(); });

    // Select the one section.
    await act(async () => { await result.current.toggleProposalSection(overview); });
    expect(result.current.selectedProposalSectionKeys.size).toBe(1);

    api.updateProposalManifest.mockClear();
    api.replaceProposalSections.mockClear();

    // Remove that same (only) section — the last one.
    await act(async () => { await result.current.removeProposalSection("test.md", ["Overview"]); });

    // The empty draft scope is persisted as targets: [] (not blocked, not corruption).
    expect(api.replaceProposalSections).toHaveBeenCalledWith("p1", { sections: [] });
    expect(api.updateProposalManifest).toHaveBeenCalledWith("p1", { intent: "", targets: [] });
    expect(result.current.selectedProposalSectionKeys.size).toBe(0);
    expect(result.current.panelError).toBeNull();
    expect(result.current.activeProposalStatus).toBe("draft");

    // The lifecycle boundary (backend) refuses locks on the empty draft; the hook
    // surfaces that refusal verbatim rather than pretending the draft is committable.
    api.acquireLocks.mockResolvedValueOnce({
      acquired: false,
      message: "Cannot acquire locks: select at least one section before entering inprogress.",
    } as never);
    await act(async () => { await result.current.acquireProposalLocks(); });
    expect(result.current.panelError).toMatch(/select at least one section/i);
    expect(result.current.activeProposalStatus).toBe("draft");
  });

  it("fixes the section scope once inprogress (scope edits refused, no save call)", async () => {
    const overview = section(["Overview"], "Overview body.\n");
    const timeline = section(["Timeline"], "Timeline body.\n");
    const { result } = renderHook(() => useProposalDrafting(params([overview, timeline])));
    await act(async () => { await result.current.startManualPublish(); });

    // Acquire locks → refresh returns inprogress → scope becomes fixed.
    api.getProposal.mockResolvedValue({ proposal: { id: "p1", status: "inprogress", intent: "Do it", sections: [{ doc_path: "test.md", heading_path: ["Overview"], content: "x" }] } });
    await act(async () => { await result.current.acquireProposalLocks(); });
    expect(result.current.activeProposalStatus).toBe("inprogress");

    api.updateProposalManifest.mockClear();
    api.replaceProposalSections.mockClear();

    // Attempting to change scope while inprogress is refused.
    await act(async () => { await result.current.toggleProposalSection(timeline); });
    expect(result.current.panelError).toMatch(/scope is locked once proposal is inprogress/i);
    expect(api.updateProposalManifest).not.toHaveBeenCalled();
    expect(api.replaceProposalSections).not.toHaveBeenCalled();
  });
});
