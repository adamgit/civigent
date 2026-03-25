/**
 * PresenceManager — encapsulates server-authoritative section focus state.
 *
 * Server-authoritative: derived from SECTION_FOCUS binary messages sent via
 * the CRDT WebSocket (crdt-sync.ts), never from the Awareness CRDT or the
 * Hub JSON WebSocket. Drives agent blocking, human-involvement scoring, and
 * presence:editing / presence:done event emission.
 */

import type { WsServerEvent } from "../types/shared.js";

export class PresenceManager {
  private readonly _focus = new Map<string, string[]>();

  /**
   * Record that writerId is now focused on headingPath.
   * Returns the previous focused path (or null if no prior focus).
   */
  setFocus(writerId: string, headingPath: string[]): { previous: string[] | null } {
    const previous = this._focus.get(writerId) ?? null;
    this._focus.set(writerId, headingPath);
    return { previous };
  }

  /**
   * Clear focus for writerId (e.g. on disconnect or blur).
   * Returns the path that was cleared (or null if none was set).
   */
  clearFocus(writerId: string): string[] | null {
    const path = this._focus.get(writerId) ?? null;
    this._focus.delete(writerId);
    return path;
  }

  /** Read-only view of all current (writerId → headingPath) entries. */
  getAll(): ReadonlyMap<string, string[]> {
    return this._focus;
  }

  /**
   * Replay all current presence state to a newly joining socket.
   * Sends one presence:editing message per focused writer.
   *
   * @param send - Raw send function for the joining socket (e.g. `socket.send`)
   * @param buildPresenceEvent - Builds the WsServerEvent for a given (writerId, headingPath) pair
   */
  replayTo(
    send: (msg: Buffer) => void,
    buildPresenceEvent: (writerId: string, headingPath: string[]) => WsServerEvent,
  ): void {
    for (const [writerId, headingPath] of this._focus.entries()) {
      const event = buildPresenceEvent(writerId, headingPath);
      send(Buffer.from(JSON.stringify(event)));
    }
  }
}
