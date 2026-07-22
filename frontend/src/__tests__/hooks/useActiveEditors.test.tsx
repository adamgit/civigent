import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Awareness } from "y-protocols/awareness";
import { useActiveEditors } from "../../hooks/useActiveEditors";

type State = { user?: { viewingSections?: string[] } };

class FakeAwareness {
  clientID = 1;
  private states = new Map<number, State>();
  private handlers = new Set<() => void>();

  set(clientID: number, state: State) {
    this.states.set(clientID, state);
  }
  getStates() {
    return this.states;
  }
  on(_event: string, handler: () => void) {
    this.handlers.add(handler);
  }
  off(_event: string, handler: () => void) {
    this.handlers.delete(handler);
  }
  emitChange() {
    for (const h of this.handlers) h();
  }
}

function asAwareness(fake: FakeAwareness): Awareness {
  return fake as unknown as Awareness;
}

describe("useActiveEditors", () => {
  it("returns [] when there is no live authority", () => {
    const fake = new FakeAwareness();
    fake.set(2, { user: { viewingSections: ["sec-a"] } });
    const { result } = renderHook(() => useActiveEditors(asAwareness(fake), false));
    expect(result.current("sec-a")).toEqual([]);
  });

  it("returns [] when awareness is null", () => {
    const { result } = renderHook(() => useActiveEditors(null, true));
    expect(result.current("sec-a")).toEqual([]);
  });

  it("groups remote viewers by fragment key and excludes the local client", () => {
    const fake = new FakeAwareness();
    fake.set(1, { user: { viewingSections: ["sec-a"] } }); // local client — excluded
    fake.set(2, { user: { viewingSections: ["sec-a"] } });
    fake.set(3, { user: { viewingSections: ["sec-a", "sec-b"] } });
    const { result } = renderHook(() => useActiveEditors(asAwareness(fake), true));
    expect(result.current("sec-a").sort()).toEqual(["2", "3"]);
    expect(result.current("sec-b")).toEqual(["3"]);
    expect(result.current("sec-c")).toEqual([]);
  });

  it("recomputes on awareness change", () => {
    const fake = new FakeAwareness();
    const { result } = renderHook(() => useActiveEditors(asAwareness(fake), true));
    expect(result.current("sec-a")).toEqual([]);
    act(() => {
      fake.set(2, { user: { viewingSections: ["sec-a"] } });
      fake.emitChange();
    });
    expect(result.current("sec-a")).toEqual(["2"]);
  });
});
