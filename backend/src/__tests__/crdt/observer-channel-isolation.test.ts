/**
 * Observer channel per-document isolation + read-only contract (spec 05
 * §Observer CRDT Channel).
 *
 * The lifecycle aspects (no-holder, no-liveness, 4021 on last-editor-leave,
 * no-publish-count) are covered in `observer-not-holder-lifecycle.test.ts`, and
 * the current-sync/bootstrap ordering in `join-and-notify-ordering.test.ts`. THIS
 * file pins the remaining public behavior: a broadcast for one document reaches
 * ONLY that document's observers (per-document isolation), and an observer socket
 * is read-only (write permission false).
 *
 * Per the item guardrail, this does NOT assert any `/ws/crdt-observe` route name
 * (observer route drift unresolved) — it drives the coordinator's broadcast +
 * socket registry directly.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  registerFakeObserverSocketForTest,
  broadcastToAll,
} from "../../ws/crdt-ws-coordinator.js";

const DOC_A = "/ops/strategy.md";
const DOC_B = "/eng/architecture.md";

describe("observer channel isolation + read-only (spec 05)", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("delivers a document's broadcast only to that document's observers", () => {
    const aFrames: Uint8Array[] = [];
    const bFrames: Uint8Array[] = [];
    const a = registerFakeObserverSocketForTest(DOC_A, "obs-a", undefined, (d) => aFrames.push(d));
    const b = registerFakeObserverSocketForTest(DOC_B, "obs-b", undefined, (d) => bFrames.push(d));
    disposers.push(a.dispose, b.dispose);

    // A broadcast scoped to DOC_A.
    broadcastToAll(DOC_A, new Uint8Array([1, 2, 3]));
    expect(aFrames).toHaveLength(1);
    expect([...aFrames[0]!]).toEqual([1, 2, 3]);
    // The DOC_B observer is isolated — it receives nothing.
    expect(bFrames).toHaveLength(0);

    // A broadcast scoped to DOC_B reaches only DOC_B.
    broadcastToAll(DOC_B, new Uint8Array([9]));
    expect(bFrames).toHaveLength(1);
    expect(aFrames).toHaveLength(1);
  });

  it("registers an observer socket as read-only (no write permission)", () => {
    const a = registerFakeObserverSocketForTest(DOC_A, "obs-readonly");
    disposers.push(a.dispose);
    expect(a.state.socketRole).toBe("observer");
    expect(a.state.canWrite).toBe(false);
    expect(a.state.canRead).toBe(true);
  });
});
