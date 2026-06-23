/**
 * Session authorship — which document fragments THIS editor instance dirtied
 * during THIS mount. A purely presentational signal: it answers "did this very
 * session produce this edit?", which `writerId` cannot (writerId answers "who
 * authored this", and replayed pending carries the original author id even for
 * work stranded from a previous session).
 *
 * The ledger is deliberately a write-only sink on one side and a read-only
 * boolean view on the other. There is no readout beyond a boolean, so there is
 * nothing to serialize: it cannot be persisted, put on the wire, or stored in
 * the replica store. The module deals in bare string keys and imports nothing
 * from `services/`, `ws/`, or `types/shared`, so any data/transport layer that
 * tried to depend on it would be importing in an obviously-wrong direction.
 */

/** Write-only: record that this session locally authored an edit to a fragment. */
export interface LocalEditOriginSink {
  recordLocalEdit(fragmentKey: string): void;
}

/** Read-only: ask whether this session authored a fragment's pending edit. */
export interface SessionAuthorshipView {
  wasAuthoredThisSession(fragmentKey: string): boolean;
}

/**
 * The only concrete implementation. Constructed once per editing mount and held
 * privately by the owner page; consumers receive it only as one of the two
 * segregated port interfaces above, never as this concrete type. Its sole state
 * is a private `Set<string>` and its only readout is a boolean — no snapshot,
 * toJSON, encode, or key enumeration exists, so it has no serialization surface.
 */
export class EphemeralSessionAuthorshipLedger
  implements LocalEditOriginSink, SessionAuthorshipView
{
  private readonly authored = new Set<string>();

  recordLocalEdit(fragmentKey: string): void {
    this.authored.add(fragmentKey);
  }

  wasAuthoredThisSession(fragmentKey: string): boolean {
    return this.authored.has(fragmentKey);
  }
}
