import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApiRouter } from "./api/routes/index.js";
import { createOAuthRouter } from "./api/routes/oauth.js";
import { createKnowledgeStoreMcpRouter } from "./mcp/index.js";
import type { WsServerEvent } from "./types/shared.js";

interface CreateAppOptions {
  onWsEvent?: (event: WsServerEvent) => void;
}

export function createApp(options?: CreateAppOptions) {
  const app = express();

  app.use(express.text({ type: ["text/markdown", "text/x-diff", "text/plain"] }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(createOAuthRouter());
  app.use("/api", createApiRouter({
    onWsEvent: options?.onWsEvent,
  }));
  app.use("/mcp", createKnowledgeStoreMcpRouter({
    onWsEvent: options?.onWsEvent,
  }));

  // In production (quickstart Docker image), serve the frontend from ./public
  const appRoot = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(appRoot, "..", "public");
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    // SPA fallback — let the frontend router handle unmatched paths
    app.get("*", (_req, res) => {
      res.sendFile(join(publicDir, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.status(200).json({
        service: "knowledge-store-backend",
        status: "ok"
      });
    });
  }

  return app;
}
