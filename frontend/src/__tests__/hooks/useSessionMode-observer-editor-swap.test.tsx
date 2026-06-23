/**
 * Observer ↔ editor transport swap (spec 05 §Observer CRDT Channel; §Session
 * Lifecycle).
 *
 * Entering edit mode must REPLACE the read-only observer sync with the full
 * editor transport (the observer is destroyed, the editor transport connects).
 * Leaving edit mode must tear down the editor transport and RE-CREATE the
 * observer sync. Asserts the real provider lifecycle, not a button label.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Track observer + transport lifecycles ──
const observerInstances: Array<{ connect: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
const transportInstances: Array<{ connect: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];

vi.mock("../../services/observer-crdt-provider", () => ({
  ObserverCrdtProvider: class {
    doc = {};
    connect = vi.fn();
    destroy = vi.fn();
    constructor() {
      observerInstances.push({ connect: this.connect, destroy: this.destroy });
    }
  },
}));

vi.mock("../../services/crdt-transport", () => ({
  CrdtTransport: class {
    doc = {};
    awareness = {};
    connect = vi.fn();
    destroy = vi.fn();
    attachStore = vi.fn();
    constructor(_docPath: string, opts: Record<string, unknown>) {
      transportInstances.push({ connect: this.connect, destroy: this.destroy });
      // Resolve the synced gate so ensureProvider settles.
      (opts.onSynced as (() => void) | undefined)?.();
    }
  },
}));

vi.mock("../../services/crdt-provider", () => ({ CrdtProvider: class {} }));

vi.mock("../../services/browser-fragment-replica-store", () => ({
  BrowserFragmentReplicaStore: class {
    destroy = vi.fn();
  },
}));

import { useSessionMode, type UseSessionModeParams } from "../../hooks/useSessionMode";

function params(): UseSessionModeParams {
  return {
    decodedDocPath: "test.md",
    sections: [],
    setSections: vi.fn() as unknown as UseSessionModeParams["setSections"],
    setError: vi.fn(),
    setStatusMessage: vi.fn(),
    loadSections: vi.fn(async () => []),
  };
}

describe("observer ↔ editor transport swap (spec 05)", () => {
  beforeEach(() => {
    observerInstances.length = 0;
    transportInstances.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("entering edit replaces the observer with the editor transport; leaving recreates the observer", async () => {
    const { result } = renderHook(() => useSessionMode(params()));

    // Start as observer.
    await act(async () => {
      await result.current.requestMode("observer");
    });
    expect(observerInstances).toHaveLength(1);
    expect(observerInstances[0].connect).toHaveBeenCalled();
    expect(transportInstances).toHaveLength(0);

    // Enter edit mode → observer destroyed, editor transport created + connected.
    await act(async () => {
      await result.current.requestMode("editor");
    });
    expect(observerInstances[0].destroy).toHaveBeenCalled();
    expect(transportInstances).toHaveLength(1);
    expect(transportInstances[0].connect).toHaveBeenCalled();

    // Leave edit mode → editor transport destroyed, observer re-created.
    act(() => {
      result.current.stopEditing();
    });
    expect(transportInstances[0].destroy).toHaveBeenCalled();
    expect(observerInstances).toHaveLength(2);
    expect(observerInstances[1].connect).toHaveBeenCalled();
  });
});
