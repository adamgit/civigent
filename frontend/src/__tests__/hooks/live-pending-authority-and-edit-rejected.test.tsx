/**
 * Hub: live pending only from replica; edit-rejected still works.
 *
 * While a live page has replica authority (`liveReplicaReadyRef.current`),
 * app-WS `section:pending` / `section:settled` must not surface as pending UI
 * state — pending truth is CRDT `pending_sections` on the LiveSectionReplica,
 * and there is no legacy store to mutate. `section:edit-rejected` remains
 * origin-only on the hub and must still fire the page modal handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import type { SectionEditRejectedEvent, WsServerEvent } from "../../types/shared";

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (h: WsEventHandler) => {
      capturedWsHandler = h;
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

function ref<T>(v: T): React.MutableRefObject<T> {
  return { current: v };
}

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(MemoryRouter, null, children);

const FRAG = "section::alpha";

function buildParams(
  liveReady: boolean,
  onSectionEditRejected: (e: SectionEditRejectedEvent) => void,
): UseDocumentWebSocketParams {
  return {
    docPath: "/test.md",
    clientInstanceId: "client-1",
    liveReplicaReadyRef: ref(liveReady),
    loadSections: vi.fn().mockResolvedValue([]),
    setError: vi.fn(),
    onSectionEditRejected,
  };
}

describe("live pending authority + edit-rejected", () => {
  beforeEach(() => {
    capturedWsHandler = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("4: hub section:pending must not update live pending; edit-rejected still reaches the page", () => {
    const onSectionEditRejected = vi.fn();
    const { result } = renderHook(
      () => useDocumentWebSocket(buildParams(true, onSectionEditRejected)),
      { wrapper },
    );

    // Disagreeing hub event — must not become live pending authority (the
    // replica owns pending while ready; there is no cold hint either).
    act(() => {
      capturedWsHandler?.({
        type: "section:pending",
        doc_path: "/test.md",
        fragment_key: FRAG,
        writer_id: "hub-writer",
        writer_display_name: "Hub Writer",
      } as unknown as WsServerEvent);
    });

    expect(result.current.coldPendingByFragmentKey.size).toBe(0);

    const rejection: SectionEditRejectedEvent = {
      type: "section:edit-rejected",
      doc_path: "/test.md",
      rejected_by: "server",
      affected_fragments: [{ fragment_key: FRAG, heading_path: ["Alpha"], heading: "Alpha" }],
      reason_code: "duplicate-sibling-heading",
      title: "Duplicate heading rejected",
      message: "collision",
      what_happened: "rename collided",
      why_rejected: "siblings cannot share a heading",
      server_action: "reverted",
      guidance: "pick a distinct name",
    };
    act(() => {
      capturedWsHandler?.(rejection);
    });
    expect(onSectionEditRejected).toHaveBeenCalledTimes(1);
    expect(onSectionEditRejected).toHaveBeenCalledWith(rejection);
  });

  it("cold hint path: section:pending/settled surface only while no live authority", () => {
    const { result } = renderHook(
      () => useDocumentWebSocket(buildParams(false, vi.fn())),
      { wrapper },
    );

    act(() => {
      capturedWsHandler?.({
        type: "section:pending",
        doc_path: "/test.md",
        fragment_key: FRAG,
        writer_id: "w1",
        writer_display_name: "Writer One",
      } as unknown as WsServerEvent);
    });
    expect(result.current.coldPendingByFragmentKey.get(FRAG)).toEqual({
      writerId: "w1",
      writerDisplayName: "Writer One",
    });

    act(() => {
      capturedWsHandler?.({
        type: "section:settled",
        doc_path: "/test.md",
        fragment_key: FRAG,
      } as unknown as WsServerEvent);
    });
    expect(result.current.coldPendingByFragmentKey.has(FRAG)).toBe(false);
  });
});
