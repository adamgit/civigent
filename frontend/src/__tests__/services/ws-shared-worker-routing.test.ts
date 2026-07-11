import { describe, it, expect } from "vitest";
import {
  isPrivateEnvelope,
  selectPrivateEnvelopeTarget,
  type RoutableTabState,
} from "../../workers/ws-shared-worker-routing";

/**
 * Shared-worker routing rules — private events must reach ONLY the tab whose
 * `clientInstanceId` matches, even when two tabs of the same writer share the
 * leader WebSocket. Broadcast events remain untouched by the private-envelope
 * check. See `frontend/src/workers/ws-shared-worker.ts` for the runtime
 * integration.
 */
describe("shared-worker routing (private envelope)", () => {
  it("recognizes a well-formed private envelope", () => {
    const envelope = {
      __private__: true as const,
      target_client_instance_id: "tab-origin",
      event: { type: "section:edit-rejected", doc_path: "/x.md" },
    };
    expect(isPrivateEnvelope(envelope)).toBe(true);
  });

  it("rejects malformed envelope shapes", () => {
    expect(isPrivateEnvelope(null)).toBe(false);
    expect(isPrivateEnvelope("string")).toBe(false);
    expect(isPrivateEnvelope({})).toBe(false);
    expect(isPrivateEnvelope({ __private__: true })).toBe(false);
    expect(
      isPrivateEnvelope({ __private__: false, target_client_instance_id: "x", event: {} }),
    ).toBe(false);
    expect(
      isPrivateEnvelope({ __private__: true, target_client_instance_id: 42, event: {} }),
    ).toBe(false);
  });

  it("routes a private envelope only to the tab with matching clientInstanceId", () => {
    const tabStates = new Map<string, RoutableTabState>([
      ["tab-origin", { clientInstanceId: "origin-id" }],
      ["tab-sibling-same-writer", { clientInstanceId: "sibling-id" }],
    ]);
    const target = selectPrivateEnvelopeTarget(
      { target_client_instance_id: "origin-id" },
      tabStates.entries(),
    );
    expect(target).toBe("tab-origin");
  });

  it("returns null when no tab matches the target clientInstanceId", () => {
    const tabStates = new Map<string, RoutableTabState>([
      ["tab-a", { clientInstanceId: "id-a" }],
      ["tab-b", { clientInstanceId: "id-b" }],
    ]);
    const target = selectPrivateEnvelopeTarget(
      { target_client_instance_id: "id-c" },
      tabStates.entries(),
    );
    expect(target).toBeNull();
  });

  it("skips tabs that have not yet identified (clientInstanceId is null)", () => {
    const tabStates = new Map<string, RoutableTabState>([
      ["tab-unidentified", { clientInstanceId: null }],
      ["tab-matching", { clientInstanceId: "target-id" }],
    ]);
    const target = selectPrivateEnvelopeTarget(
      { target_client_instance_id: "target-id" },
      tabStates.entries(),
    );
    expect(target).toBe("tab-matching");
  });

  it("does not route a broadcast (non-envelope) shape", () => {
    // Sanity check: a plain server event is not an envelope.
    const plain = { type: "doc:structure-changed", doc_path: "/x.md", sections: [] };
    expect(isPrivateEnvelope(plain)).toBe(false);
  });
});
