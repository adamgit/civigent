/**
 * CRDT WebSocket upgrade auth (spec 05 §Wire protocol; spec 12 human-only live
 * editing).
 *
 * The CRDT (editor) socket upgrade rejects unauthenticated callers AND agent
 * callers with the auth-failed close code, and accepts an authorized human. This
 * does NOT touch the unresolved Open/Register/Verify agent-auth modes — it pins
 * the editor-channel admission rule only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createCrdtWsServer } from "../../ws/crdt-ws-coordinator.js";
import * as transport from "../../ws/crdt-transport.js";
import * as acl from "../../auth/acl.js";
import { WS_CLOSE_AUTH_FAILED } from "../../ws/crdt-ws-frames.js";
import { authFor } from "../helpers/auth.js";

const CRDT_URL = "/ws/crdt/ops/strategy.md";

function fakeSocket(): Duplex {
  return {
    writable: true,
    write: vi.fn(),
    destroy: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    setTimeout: vi.fn(),
    setNoDelay: vi.fn(),
    setKeepAlive: vi.fn(),
  } as unknown as Duplex;
}

function request(authorization?: string): IncomingMessage {
  const headers: Record<string, string> = { host: "localhost" };
  if (authorization) headers.authorization = authorization;
  return { url: CRDT_URL, headers } as unknown as IncomingMessage;
}

describe("CRDT upgrade auth (spec 05 / spec 12)", () => {
  let rejectSpy: ReturnType<typeof vi.spyOn>;
  let prevAuthMode: string | undefined;

  beforeEach(() => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc"; // strict: no credentials → rejected
    rejectSpy = vi.spyOn(transport, "rejectUpgrade").mockImplementation(() => {});
    // Isolate the writer-type rule from document permissions: grant read.
    vi.spyOn(acl, "checkDocPermission").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  function lastRejectCode(): number | undefined {
    const call = rejectSpy.mock.calls.at(-1);
    return call ? (call[4] as number) : undefined;
  }

  it("rejects an unauthenticated caller with auth-failed", async () => {
    const server = createCrdtWsServer();
    await server.handleUpgrade(request(undefined), fakeSocket(), Buffer.alloc(0));
    expect(rejectSpy).toHaveBeenCalled();
    expect(lastRejectCode()).toBe(WS_CLOSE_AUTH_FAILED);
  });

  it("rejects an agent caller with auth-failed (agents cannot use CRDT)", async () => {
    const server = createCrdtWsServer();
    await server.handleUpgrade(request(authFor("agent-1", "agent")), fakeSocket(), Buffer.alloc(0));
    expect(rejectSpy).toHaveBeenCalled();
    expect(lastRejectCode()).toBe(WS_CLOSE_AUTH_FAILED);
  });

  it("accepts an authorized human editor (no rejection)", async () => {
    const server = createCrdtWsServer();
    await server.handleUpgrade(request(authFor("human-1", "human")), fakeSocket(), Buffer.alloc(0));
    expect(rejectSpy).not.toHaveBeenCalled();
  });
});
