/**
 * Draft proposal indicators (spec 02 §3 events; spec 06 signals).
 *
 * A `proposal:draft` event surfaces a per-section indicator carrying the writer
 * display name and the proposal intent FROM THE EVENT PAYLOAD (not a hardcoded
 * label), keyed to the relevant draft target sections. The indicators clear when
 * the proposal is withdrawn or its sections are committed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import { sectionHeadingKey, type WsServerEvent } from "../../types/shared";
type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (handler: WsEventHandler) => {
      capturedWsHandler = handler;
    };
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

vi.mock("../../services/api-client", () => ({
  apiClient: { getWorkspaceDocumentSections: async () => ({ sections: [] }) },
  resolveWriterId: () => "test-user",
}));

import { useDocumentWebSocket, type UseDocumentWebSocketParams } from "../../hooks/useDocumentWebSocket";

function ref<T>(value: T): React.MutableRefObject<T> {
  return { current: value };
}

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(MemoryRouter, null, children);

function buildParams(): UseDocumentWebSocketParams {
  return {
    decodedDocPath: "/test.md",
    clientInstanceId: "client-1",
    liveReplicaReadyRef: ref(false),
    setStructureTree: vi.fn() as unknown as UseDocumentWebSocketParams["setStructureTree"],
    loadSections: vi.fn(async () => []),
    setError: vi.fn(),
  };
}

function emit(event: Record<string, unknown>): void {
  act(() => {
    capturedWsHandler?.(event as unknown as WsServerEvent);
  });
}

describe("draft proposal indicators (spec 02 §3 events)", () => {
  beforeEach(() => {
    capturedWsHandler = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces writer + intent from the event payload for the targeted sections", () => {
    const { result } = renderHook(() => useDocumentWebSocket(buildParams()), { wrapper });

    emit({
      type: "proposal:draft",
      proposal_id: "p1",
      doc_path: "/test.md",
      heading_paths: [["Overview"], ["Timeline"]],
      writer_id: "alice",
      writer_display_name: "Alice",
      intent: "Tighten the overview and timeline",
    });

    const byKey = result.current.proposalsBySectionKey;
    const overview = byKey.get(sectionHeadingKey(["Overview"]));
    const timeline = byKey.get(sectionHeadingKey(["Timeline"]));
    expect(overview).toHaveLength(1);
    expect(timeline).toHaveLength(1);
    // Payload-driven, not a static label.
    expect(overview![0].writerDisplayName).toBe("Alice");
    expect(overview![0].intent).toBe("Tighten the overview and timeline");
    expect(overview![0].proposalId).toBe("p1");
  });

  it("clears the indicators when the proposal is withdrawn", () => {
    const { result } = renderHook(() => useDocumentWebSocket(buildParams()), { wrapper });
    emit({
      type: "proposal:draft",
      proposal_id: "p1",
      doc_path: "/test.md",
      heading_paths: [["Overview"]],
      writer_id: "alice",
      writer_display_name: "Alice",
      intent: "Edit overview",
    });
    expect(result.current.pendingProposalIndicators).toHaveLength(1);

    emit({
      type: "proposal:withdrawn",
      proposal_id: "p1",
      doc_path: "/test.md",
      heading_paths: [["Overview"]],
    });
    expect(result.current.pendingProposalIndicators).toHaveLength(0);
  });

  it("clears a section's indicator when that section is committed", () => {
    const { result } = renderHook(() => useDocumentWebSocket(buildParams()), { wrapper });
    emit({
      type: "proposal:draft",
      proposal_id: "p2",
      doc_path: "/test.md",
      heading_paths: [["Overview"]],
      writer_id: "bob",
      writer_display_name: "Bob",
      intent: "Rework overview",
    });
    expect(result.current.pendingProposalIndicators).toHaveLength(1);

    emit({
      type: "content:committed",
      doc_path: "/test.md",
      writer_display_name: "Bob",
      writer_type: "human",
      sections: [{ doc_path: "/test.md", heading_path: ["Overview"] }],
      commit_sha: "abc",
    });
    expect(result.current.pendingProposalIndicators).toHaveLength(0);
  });
});
