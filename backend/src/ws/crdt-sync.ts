/**
 * crdt-sync.ts — thin entry point for the CRDT WebSocket subsystem.
 *
 * Re-exports the public API from the three-layer architecture:
 *   crdt-protocol.ts   — binary wire format (MSG_* constants, encode/decode)
 *   crdt-transport.ts  — socket lifecycle utilities (socketState, broadcast helpers)
 *   crdt-coordinator.ts — session coordinator (handleMessage, connection handlers)
 *
 * Callers (server.ts, tests) import from this module for backward compatibility.
 */

export { createCrdtWsServer, setCrdtEventHandler, type CrdtWsServer } from "./crdt-coordinator.js";
export { encodeUpdate } from "./crdt-protocol.js";
export { broadcastToAll } from "./crdt-coordinator.js";
