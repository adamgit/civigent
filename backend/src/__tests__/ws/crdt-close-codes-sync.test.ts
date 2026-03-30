/**
 * Enforces frontend/backend parity for WS_CLOSE_* close codes.
 * If this test fails, a close code was added/changed in one place but not the other.
 */

import { describe, it, expect } from "vitest";
import * as backend from "../../ws/crdt-protocol.js";
import * as frontend from "../../../../frontend/src/services/crdt-close-codes.js";

describe("WS_CLOSE_* constants sync between backend and frontend", () => {
  const backendCodes = Object.entries(backend).filter(([k]) => k.startsWith("WS_CLOSE_"));
  const frontendCodes = Object.entries(frontend).filter(([k]) => k.startsWith("WS_CLOSE_"));

  it("backend exports at least one WS_CLOSE_* constant", () => {
    expect(backendCodes.length).toBeGreaterThan(0);
  });

  it("every backend WS_CLOSE_* exists in frontend with the same value", () => {
    for (const [name, value] of backendCodes) {
      const frontendEntry = frontendCodes.find(([k]) => k === name);
      expect(frontendEntry, `Missing in frontend: ${name}`).toBeDefined();
      expect(frontendEntry![1], `Value mismatch for ${name}`).toBe(value);
    }
  });

  it("every frontend WS_CLOSE_* exists in backend with the same value", () => {
    for (const [name, value] of frontendCodes) {
      const backendEntry = backendCodes.find(([k]) => k === name);
      expect(backendEntry, `Missing in backend: ${name}`).toBeDefined();
      expect(backendEntry![1], `Value mismatch for ${name}`).toBe(value);
    }
  });
});
