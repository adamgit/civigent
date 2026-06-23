/**
 * Live public CRDT close-code VALUES (spec 05 §Close codes).
 *
 * The FE/BE parity sync is enforced in `crdt-close-codes-sync.test.ts`. THIS file
 * pins the actual numeric values so a same-value-but-wrong drift can't slip
 * through, and guards that the REMOVED `4020` idle-timeout code is not
 * reintroduced (there is no idle timer in this architecture).
 */

import { describe, it, expect } from "vitest";
import * as backend from "../../ws/crdt-ws-frames.js";

describe("live public close-code values (spec 05)", () => {
  it("pins 4021 (session ended), 4022 (document replaced), 4024 (admin rebuild)", () => {
    expect(backend.WS_CLOSE_SESSION_ENDED).toBe(4021);
    expect(backend.WS_CLOSE_DOCUMENT_REPLACED).toBe(4022);
    expect(backend.WS_CLOSE_ADMIN_REBUILD).toBe(4024);
  });

  it("admin-rebuild (4024) is distinct from session-ended and document-replaced", () => {
    const codes = new Set([
      backend.WS_CLOSE_SESSION_ENDED,
      backend.WS_CLOSE_DOCUMENT_REPLACED,
      backend.WS_CLOSE_ADMIN_REBUILD,
    ]);
    expect(codes.size).toBe(3);
  });

  it("does not reintroduce the removed 4020 idle-timeout code", () => {
    const values = Object.entries(backend)
      .filter(([k]) => k.startsWith("WS_CLOSE_"))
      .map(([, v]) => v);
    expect(values).not.toContain(4020);
  });
});
