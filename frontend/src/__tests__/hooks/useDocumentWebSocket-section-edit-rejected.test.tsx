/**
 * `section:edit-rejected` origin-only routing in `useDocumentWebSocket`.
 *
 * The hook must:
 *  - Forward a rejection event for the current document to the page-level
 *    `onSectionEditRejected` callback with the full payload.
 *  - Ignore rejection events for OTHER documents (doc_path mismatch → no
 *    callback fires).
 *  - Not route rejections into generic error state, section-block state, or
 *    section-pending state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import type {
  SectionEditRejectedEvent,
  WsServerEvent,
} from "../../types/shared";
import type { DocumentSection } from "../../pages/document-page-utils";

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;
let subscribeArgs: Array<{ docPath: string; clientInstanceId: string | undefined }> = [];

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (handler: WsEventHandler) => {
      capturedWsHandler = handler;
    };
    subscribe = (docPath: string, clientInstanceId?: string) => {
      subscribeArgs.push({ docPath, clientInstanceId });
    };
    unsubscribe = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

vi.mock("../../services/api-client", () => ({
  apiClient: {
    getWorkspaceDocumentSections: async () => ({ sections: [] as DocumentSection[] }),
  },
  resolveWriterId: () => "test-user",
}));

import {
  useDocumentWebSocket,
  type UseDocumentWebSocketParams,
} from "../../hooks/useDocumentWebSocket";

function ref<T>(value: T): React.MutableRefObject<T> {
  return { current: value };
}

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(MemoryRouter, null, children);

function buildParams(
  docPath: string,
  onSectionEditRejected: (event: SectionEditRejectedEvent) => void,
  clientInstanceId: string = "tab-instance-id",
): UseDocumentWebSocketParams {
  return {
    decodedDocPath: docPath,
    clientInstanceId,
    liveReplicaReadyRef: ref(false),
    setStructureTree: vi.fn() as unknown as UseDocumentWebSocketParams["setStructureTree"],
    loadSections: vi.fn().mockResolvedValue([]),
    setError: vi.fn(),
    onSectionEditRejected,
  };
}

function buildRejection(docPath: string): SectionEditRejectedEvent {
  return {
    type: "section:edit-rejected",
    doc_path: docPath,
    rejected_by: "server",
    affected_fragments: [
      { fragment_key: "section::overview", heading_path: ["Overview"], heading: "Overview" },
    ],
    reason_code: "duplicate-sibling-heading",
    title: "Duplicate heading rejected",
    message: "Two sections would end up with the same heading.",
    what_happened: "Your rename would collide with a sibling.",
    why_rejected: "Two siblings cannot share the same heading.",
    server_action: "Your edit was reverted.",
    guidance: "Rename to something distinct.",
  };
}

describe("useDocumentWebSocket — section:edit-rejected routing", () => {
  beforeEach(() => {
    capturedWsHandler = null;
    subscribeArgs = [];
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards a rejection event for the current doc to the page-level handler", () => {
    const onSectionEditRejected = vi.fn();
    const params = buildParams("/current.md", onSectionEditRejected);
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    const event = buildRejection("/current.md");
    capturedWsHandler?.(event);

    expect(onSectionEditRejected).toHaveBeenCalledTimes(1);
    expect(onSectionEditRejected).toHaveBeenCalledWith(event);
  });

  it("ignores a rejection event addressed to a different document", () => {
    const onSectionEditRejected = vi.fn();
    const params = buildParams("/current.md", onSectionEditRejected);
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    capturedWsHandler?.(buildRejection("/other.md"));
    expect(onSectionEditRejected).not.toHaveBeenCalled();
  });

  it("does not surface the rejection through the generic error setter or refresh path", () => {
    const onSectionEditRejected = vi.fn();
    const params = buildParams("/current.md", onSectionEditRejected);
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    capturedWsHandler?.(buildRejection("/current.md"));

    // The rejection must not be routed into the generic error banner, and
    // must not trigger a REST section refresh.
    expect(params.setError).not.toHaveBeenCalled();
    expect(params.loadSections).not.toHaveBeenCalled();
  });

  it("binds the tab's clientInstanceId at subscribe time so the hub can route private events", () => {
    const onSectionEditRejected = vi.fn();
    const params = buildParams("/current.md", onSectionEditRejected, "my-tab-abc123");
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    expect(subscribeArgs).toEqual([{ docPath: "/current.md", clientInstanceId: "my-tab-abc123" }]);
  });
});
