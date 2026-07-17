/**
 * Test helper: attach a bootstrapped live-section recipient to an open DocSession
 * and capture the ordered `LiveSectionsBootstrapFrame` / `LiveSectionsUpdateFrame`
 * frames it receives on the DocSession CRDT channel.
 *
 * The live-section redesign moved live topology / editability authority OFF the
 * application WebSocket onto ordered CRDT frames (opcodes 0x14 / 0x15). Backend
 * tests that used to assert app-WS `doc:structure-changed` / `section:blocked` /
 * `section:gone` now assert on these frames instead — this helper is the shared
 * capture seam so each test does not re-implement the join + decode dance.
 */

import {
  joinAndNotify,
  registerFakeObserverSocketForTest,
} from "../../ws/crdt-ws-coordinator.js";
import {
  MSG_LIVE_SECTIONS_BOOTSTRAP,
  MSG_LIVE_SECTIONS_UPDATE,
  decodeMessage,
  decodeLiveSectionsBootstrap,
  decodeLiveSectionsUpdate,
  type LiveSectionsBootstrapFrame,
  type LiveSectionsUpdateFrame,
} from "../../ws/crdt-ws-frames.js";
import type { DocSession } from "../../crdt/ydoc-lifecycle.js";
import type { WireLiveSectionsState } from "../../types/shared.js";

export interface LiveRecipient {
  /** Every raw frame this recipient was sent, in send order (bootstrap + updates + Yjs deltas). */
  readonly raw: Uint8Array[];
  /** The single bootstrap frame captured at join. */
  bootstrap(): LiveSectionsBootstrapFrame;
  /** All live-section UPDATE frames received after the bootstrap, in order. */
  updates(): LiveSectionsUpdateFrame[];
  /**
   * The most recent live-section control `state` this recipient has observed —
   * from the last UPDATE frame carrying `state`, or the bootstrap if none has.
   */
  latestState(): WireLiveSectionsState;
  /** Discard everything received so far (e.g. to isolate frames after a setup step). */
  clear(): void;
  dispose(): void;
}

/**
 * Register an observer socket, bootstrap it onto the live-section channel, and
 * drain the actor lane so the bootstrap frame lands. Call BEFORE the action under
 * test so the recipient receives its ordered update frames.
 */
export async function joinLiveRecipient(
  session: DocSession,
  socketId = "live-recipient",
): Promise<LiveRecipient> {
  const raw: Uint8Array[] = [];
  const reg = registerFakeObserverSocketForTest(session.docPath, socketId, undefined, (d) => raw.push(d));
  reg.state.joined = false;
  joinAndNotify(session, reg.socket, reg.state);
  await session.enqueue(() => undefined); // drain the lane so the bootstrap send lands

  function framesOfType<T>(type: number, decode: (payload: Uint8Array) => T): T[] {
    return raw
      .map((d) => decodeMessage(d))
      .filter((m): m is { type: number; payload: Uint8Array } => !!m && m.type === type)
      .map((m) => decode(m.payload));
  }

  return {
    raw,
    bootstrap(): LiveSectionsBootstrapFrame {
      const boots = framesOfType(MSG_LIVE_SECTIONS_BOOTSTRAP, decodeLiveSectionsBootstrap);
      if (boots.length !== 1) throw new Error(`expected exactly one bootstrap frame, got ${boots.length}`);
      return boots[0];
    },
    updates(): LiveSectionsUpdateFrame[] {
      return framesOfType(MSG_LIVE_SECTIONS_UPDATE, decodeLiveSectionsUpdate);
    },
    latestState(): WireLiveSectionsState {
      const withState = this.updates().filter((u) => u.state !== undefined);
      if (withState.length > 0) return withState[withState.length - 1].state!;
      return this.bootstrap().state;
    },
    clear(): void {
      raw.length = 0;
    },
    dispose: reg.dispose,
  };
}
