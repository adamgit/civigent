/**
 * Fragment-scoped awareness presence (spec 05 §Observer/Awareness; cursors are
 * scoped per Y.XmlFragment / section).
 *
 * Each mounted editor binds to ONE fragment and advertises `viewingSections:[fk]`
 * in its awareness user state. `useViewingPresence(awareness, sectionKey)` must
 * surface ONLY the remote users whose awareness includes that section — a user in
 * a different fragment does NOT appear, and the local client never appears. This
 * is the per-section scoping behind "cursors from one fragment don't render in
 * another editor".
 */

import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";
import { useViewingPresence } from "../../hooks/useViewingPresence";

const OVERVIEW = "frag:sec_overview";
const TIMELINE = "frag:sec_timeline";

const docs: Y.Doc[] = [];

function makeRemote(name: string, color: string, viewingSections: string[]): Awareness {
  const doc = new Y.Doc();
  docs.push(doc);
  const aw = new Awareness(doc);
  aw.setLocalStateField("user", { name, color, viewingSections });
  return aw;
}

function pushInto(target: Awareness, remote: Awareness): void {
  const update = encodeAwarenessUpdate(remote, [remote.clientID]);
  applyAwarenessUpdate(target, update, "test");
}

describe("fragment-scoped viewing presence (spec 05)", () => {
  afterEach(() => {
    while (docs.length) docs.pop()!.destroy();
  });

  it("shows only remote users in the same section, excluding the local client", () => {
    const localDoc = new Y.Doc();
    docs.push(localDoc);
    const local = new Awareness(localDoc);
    // Local client is also "viewing" Overview — must still be excluded from its own list.
    local.setLocalStateField("user", { name: "Me", color: "#000", viewingSections: [OVERVIEW] });

    const alice = makeRemote("Alice", "#f00", [OVERVIEW]);
    const bob = makeRemote("Bob", "#00f", [TIMELINE]);
    pushInto(local, alice);
    pushInto(local, bob);

    const overview = renderHook(() => useViewingPresence(local, OVERVIEW));
    // Only Alice (same section); NOT Bob (different fragment), NOT the local user.
    expect(overview.result.current.map((u) => u.name)).toEqual(["Alice"]);

    const timeline = renderHook(() => useViewingPresence(local, TIMELINE));
    expect(timeline.result.current.map((u) => u.name)).toEqual(["Bob"]);
  });

  it("updates when a remote user moves to another section", () => {
    const localDoc = new Y.Doc();
    docs.push(localDoc);
    const local = new Awareness(localDoc);

    const carol = makeRemote("Carol", "#0a0", [OVERVIEW]);
    pushInto(local, carol);

    const { result } = renderHook(() => useViewingPresence(local, OVERVIEW));
    expect(result.current.map((u) => u.name)).toEqual(["Carol"]);

    // Carol moves to Timeline → she leaves Overview's viewer list.
    act(() => {
      carol.setLocalStateField("user", { name: "Carol", color: "#0a0", viewingSections: [TIMELINE] });
      pushInto(local, carol);
    });
    expect(result.current).toEqual([]);
  });
});
