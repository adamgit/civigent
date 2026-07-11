/**
 * Pure routing helpers for the app-WebSocket shared worker.
 *
 * The worker owns two responsibilities that a unit test can exercise without a
 * live SharedWorker: (1) recognizing a private-event envelope from the hub, and
 * (2) delivering that envelope's inner event to ONLY the tab whose
 * `clientInstanceId` matches. Extracting these two into a shape-only module
 * keeps the routing rules covered by fast tests without spinning up a
 * SharedWorker in the test runner.
 *
 * See `ws-shared-worker.ts` for the shared-worker integration and
 * `backend/src/ws/hub.ts` (`sendPrivate`) for the envelope contract.
 */

export interface PrivateEnvelope {
  __private__: true;
  target_client_instance_id: string;
  event: unknown;
}

export function isPrivateEnvelope(value: unknown): value is PrivateEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __private__?: unknown }).__private__ === true &&
    typeof (value as { target_client_instance_id?: unknown }).target_client_instance_id === "string"
  );
}

export interface RoutableTabState {
  clientInstanceId: string | null;
}

/**
 * Return the ONE tab id whose `clientInstanceId` matches the envelope target,
 * or `null` when no tab matches. The caller is responsible for actually
 * forwarding the event to that tab — this function stays purely decision-only
 * so it can be unit-tested against a plain `Map` of tab states without spinning
 * up ports.
 *
 * Matching semantics:
 *  - Exactly one tab per `clientInstanceId`; the first match wins (in
 *    practice the ids are per-tab UUIDs so at most one match ever exists).
 *  - A tab with `clientInstanceId: null` is never a target — until the tab
 *    identifies itself, private routing skips it.
 *  - Silent drop when no tab matches (the origin tab may have already
 *    closed and re-broadcasting would leak the rejection into unrelated tabs).
 */
export function selectPrivateEnvelopeTarget(
  envelope: { target_client_instance_id: string },
  tabStates: Iterable<[string, RoutableTabState]>,
): string | null {
  for (const [tabId, state] of tabStates) {
    if (state.clientInstanceId === envelope.target_client_instance_id) return tabId;
  }
  return null;
}
