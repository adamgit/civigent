import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { createApiRouter } from "./api/routes/index.js";
import { createOAuthRouter } from "./api/routes/oauth.js";
import { createKnowledgeStoreMcpRouter, createAutoDetectMcpRouter } from "./mcp/index.js";
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
  // Tiered MCP mounts — explicit tiers first so /mcp/tierN isn't swallowed by /mcp
  app.use("/mcp/tier1", createKnowledgeStoreMcpRouter({ tier: 1, onWsEvent: options?.onWsEvent }));
  app.use("/mcp/tier2", createKnowledgeStoreMcpRouter({ tier: 2, onWsEvent: options?.onWsEvent }));
  app.use("/mcp/tier3", createKnowledgeStoreMcpRouter({ tier: 3, onWsEvent: options?.onWsEvent }));
  app.use("/mcp", createAutoDetectMcpRouter({ onWsEvent: options?.onWsEvent }));

  // In production (quickstart Docker image), serve the frontend from ./public
  const publicDir = join(process.cwd(), "public");
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir, {
      setHeaders(res, filePath) {
        if (filePath.endsWith("/index.html") || filePath.endsWith("\\index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.includes("/assets/") || filePath.includes("\\assets\\")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
    // SPA fallback — let the frontend router handle unmatched paths
    app.get("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
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
