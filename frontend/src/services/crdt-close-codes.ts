/**
 * WebSocket close codes shared between frontend and backend.
 * Must stay in sync with backend/src/ws/crdt-protocol.ts WS_CLOSE_* constants.
 */

export const WS_CLOSE_AUTH_REQUIRED = 4001;
export const WS_CLOSE_INVALID_URL = 4010;
export const WS_CLOSE_AUTH_FAILED = 4011;
export const WS_CLOSE_AUTHORIZATION_FAILED = 4013;
export const WS_CLOSE_YDOC_INIT_FAILED = 4014;
export const WS_CLOSE_IDLE_TIMEOUT = 4020;
export const WS_CLOSE_SESSION_ENDED = 4021;
export const WS_CLOSE_DOCUMENT_RESTORED = 4022;
export const WS_CLOSE_SUPERSEDED = 4023;
export const WS_CLOSE_REASON_MAX_LENGTH = 123;
