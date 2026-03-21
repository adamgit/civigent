import { createApp } from "../../app.js";
import { createTempDataRoot, type TempDataRootContext } from "./temp-data-root.js";
import { authFor } from "./auth.js";
import { setSystemReady } from "../../startup-state.js";
import type { WsServerEvent } from "../../types/shared.js";
import type { Express } from "express";

export interface TestServerContext {
  app: Express;
  dataCtx: TempDataRootContext;
  humanToken: string;
  agentToken: string;
  humanId: string;
  agentId: string;
  /** All WS events captured during the test */
  wsEvents: WsServerEvent[];
  cleanup: () => Promise<void>;
}

/**
 * Creates an Express app backed by a temp data root with git repo,
 * pre-generated auth tokens, and captured WS events.
 */
export async function createTestServer(): Promise<TestServerContext> {
  const dataCtx = await createTempDataRoot();
  const wsEvents: WsServerEvent[] = [];

  // Mark system as ready for tests (no crash recovery phase)
  setSystemReady();

  const app = createApp({
    onWsEvent: (event) => wsEvents.push(event),
  });

  const humanId = "human-test-user";
  const agentId = "agent-test-bot";
  const humanToken = authFor(humanId, "human");
  const agentToken = authFor(agentId, "agent");

  return {
    app,
    dataCtx,
    humanToken,
    agentToken,
    humanId,
    agentId,
    wsEvents,
    cleanup: dataCtx.cleanup,
  };
}
