import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { FatalStateRegistry } from "../../runtime/fatal-state-registry.js";

/**
 * Tests the SSE system-events behavior via FatalStateRegistry.
 *
 * The /api/system/events endpoint lives in dev-supervisor.ts (not in the
 * Express app), so we create a minimal HTTP server that mirrors the supervisor's
 * SSE handler to test the full HTTP path.
 */
describe("GET /api/system/events SSE", () => {
  let server: Server | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it("returns SSE stream with system_state ready event", async () => {
    const registry = new FatalStateRegistry();
    registry.setReady();

    server = createServer((req, res) => {
      if (req.url === "/api/system/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        registry.addClient(res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const port = await new Promise<number>((resolve) => {
      server!.listen(0, () => {
        resolve((server!.address() as { port: number }).port);
      });
    });

    const res = await fetch(`http://localhost:${port}/api/system/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read the first SSE event from the stream
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    reader.cancel();

    expect(text).toContain("event: system_state");
    expect(text).toContain('"ready"');
  });
});
