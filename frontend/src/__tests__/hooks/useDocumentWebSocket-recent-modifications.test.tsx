/**
 * Recent-modification attribution from committed data (spec 06 §Signals).
 *
 * A `content:committed` event records, per changed section, the committing
 * writer's display name so the recent-modification UI can attribute the change.
 * Attribution is per-section (different committers attribute their own sections).
 *
 * Only the required attribution DATA is asserted — not optional highlight/anim.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import type { WsServerEvent } from "../../types/shared";
type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (h: WsEventHandler) => { capturedWsHandler = h; };
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

function ref<T>(v: T): React.MutableRefObject<T> { return { current: v }; }
const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(MemoryRouter, null, children);

function buildParams(): UseDocumentWebSocketParams {
  return {
    decodedDocPath: "test.md",
    clientInstanceId: "client-1",
    liveReplicaReadyRef: ref(false),
    setStructureTree: vi.fn() as unknown as UseDocumentWebSocketParams["setStructureTree"],
    loadSections: vi.fn(async () => []),
    setError: vi.fn(),
  };
}

function emit(event: Record<string, unknown>): void {
  act(() => { capturedWsHandler?.(event as unknown as WsServerEvent); });
}

describe("recent-modification attribution from committed data (spec 06)", () => {
  beforeEach(() => { capturedWsHandler = null; });
  afterEach(() => { vi.clearAllMocks(); });

  it("records the committing writer's display name per changed section", () => {
    const { result } = renderHook(() => useDocumentWebSocket(buildParams()), { wrapper });

    emit({
      type: "content:committed",
      doc_path: "test.md",
      writer_display_name: "Dana",
      writer_type: "human",
      sections: [
        { doc_path: "test.md", heading_path: ["Overview"] },
        { doc_path: "test.md", heading_path: [] },
      ],
      commit_sha: "sha1",
    });

    const byLabel = result.current.recentlyChangedByLabel;
    expect(byLabel.get("Overview")?.changedByName).toBe("Dana");
    expect(byLabel.get("(before first heading)")?.changedByName).toBe("Dana");
  });

  it("attributes each section to its own committer", () => {
    const { result } = renderHook(() => useDocumentWebSocket(buildParams()), { wrapper });

    emit({
      type: "content:committed",
      doc_path: "test.md",
      writer_display_name: "Dana",
      writer_type: "human",
      sections: [{ doc_path: "test.md", heading_path: ["Overview"] }],
      commit_sha: "sha1",
    });
    emit({
      type: "content:committed",
      doc_path: "test.md",
      writer_display_name: "Evan",
      writer_type: "agent",
      sections: [{ doc_path: "test.md", heading_path: ["Timeline"] }],
      commit_sha: "sha2",
    });

    const byLabel = result.current.recentlyChangedByLabel;
    expect(byLabel.get("Overview")?.changedByName).toBe("Dana");
    expect(byLabel.get("Timeline")?.changedByName).toBe("Evan");
  });
});
