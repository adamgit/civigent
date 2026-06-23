/**
 * Shared initial-load observer guard (DocumentPage + GovernanceDocumentPage route
 * through this one hook). On load resolution it must start observer ONLY when the
 * user has not already entered edit mode — read from `controllerStateRef.current`
 * so a click-to-edit that landed during the load (committed synchronously by
 * useSessionMode) suppresses the observer and the caret survives.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { DocumentSessionControllerState } from "../../types/shared";
import { useInitialObserverGuard } from "../../hooks/useInitialObserverGuard";

function controllerState(requestedMode: DocumentSessionControllerState["requestedMode"]): DocumentSessionControllerState {
  return {
    clientInstanceId: "c1",
    requestedMode,
    clientRole: null,
    attachmentState: "detached",
    docSessionId: null,
    editorFocusTarget: null,
    pendingTransition: null,
  };
}

function buildParams(requestedMode: DocumentSessionControllerState["requestedMode"]) {
  const requestMode = vi.fn(async () => {});
  const stopObserver = vi.fn();
  const loadSections = vi.fn(async () => []);
  const controllerStateRef = { current: controllerState(requestedMode) };
  return {
    params: { decodedDocPath: "test.md", loadSections, requestMode, stopObserver, controllerStateRef },
    requestMode,
    stopObserver,
    loadSections,
  };
}

describe("useInitialObserverGuard", () => {
  it("starts observer when the user has NOT entered edit mode during load", async () => {
    const { params, requestMode, loadSections } = buildParams("none");
    renderHook(() => useInitialObserverGuard(params));
    await waitFor(() => expect(loadSections).toHaveBeenCalledWith("test.md"));
    await waitFor(() => expect(requestMode).toHaveBeenCalledWith("observer"));
  });

  it("does NOT start observer when edit mode was entered during load (ref reads 'editor')", async () => {
    const { params, requestMode, loadSections } = buildParams("editor");
    renderHook(() => useInitialObserverGuard(params));
    await waitFor(() => expect(loadSections).toHaveBeenCalledWith("test.md"));
    // Give the resolved continuation a chance to run, then assert observer NOT requested.
    await new Promise((r) => setTimeout(r, 0));
    expect(requestMode).not.toHaveBeenCalled();
  });

  it("stops the observer on unmount", async () => {
    const { params, stopObserver } = buildParams("none");
    const { unmount } = renderHook(() => useInitialObserverGuard(params));
    unmount();
    expect(stopObserver).toHaveBeenCalled();
  });
});
