/**
 * WebSocket close codes shared between frontend and backend.
 * Must stay in sync with backend/src/ws/crdt-ws-frames.ts WS_CLOSE_* constants.
 *
 * (4020 is unused/reserved: there is no idle timer in this architecture.)
 */

export const WS_CLOSE_AUTH_REQUIRED = 4001;
export const WS_CLOSE_INVALID_URL = 4010;
export const WS_CLOSE_AUTH_FAILED = 4011;
export const WS_CLOSE_AUTHORIZATION_FAILED = 4013;
export const WS_CLOSE_YDOC_INIT_FAILED = 4014;
export const WS_CLOSE_SESSION_ENDED = 4021;
export const WS_CLOSE_DOCUMENT_REPLACED = 4022;
export const WS_CLOSE_SUPERSEDED = 4023;
/** Admin force-rebuild invalidation; reconnect immediately and reseed from new canonical. */
export const WS_CLOSE_ADMIN_REBUILD = 4024;
/**
 * Admin-triggered whole-instance lockdown for backup or restore. Sockets
 * closed with this code should be treated as a system-starting condition:
 * reconnect through the existing readiness/backoff path once the readiness
 * gate reopens.
 */
export const WS_CLOSE_SYSTEM_LOCKDOWN = 4025;
export const WS_CLOSE_REASON_MAX_LENGTH = 123;
