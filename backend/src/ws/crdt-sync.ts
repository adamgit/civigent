/**
 * crdt-sync.ts — thin entry point for the CRDT WebSocket subsystem.
 *
 * Re-exports the public API from the three-layer architecture:
 *   crdt-ws-frames.ts      — binary wire format (MSG_* constants, encode/decode)
 *   crdt-transport.ts      — socket lifecycle utilities (socketState, send helper)
 *   crdt-ws-coordinator.ts — WS session coordinator (handleMessage, connection handlers)
 *
 * Callers (server.ts, tests) import from this module for backward compatibility.
 */

export {
  createCrdtWsServer,
  setCrdtEventHandler,
  setCrdtPrivateEventHandler,
  type CrdtWsServer,
} from "./crdt-ws-coordinator.js";
export { encodeUpdate } from "./crdt-ws-frames.js";
export { broadcastToAll } from "./crdt-ws-coordinator.js";
