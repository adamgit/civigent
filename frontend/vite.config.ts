import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const rootPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const appVersion = rootPkg.version.split(".").slice(0, 2).join(".");
let buildSha = "dev";
try { buildSha = execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim(); } catch { /* dev fallback */ }
const buildDate = new Date().toISOString();

const backendTarget = process.env.VITE_BACKEND_TARGET ?? "http://localhost:3000";
const backendUrl = new URL(backendTarget);
const wsProtocol = backendUrl.protocol === "https:" ? "wss:" : "ws:";
const backendWsTarget = `${wsProtocol}//${backendUrl.host}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_SHA__: JSON.stringify(buildSha),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  resolve: {
    dedupe: [
      "prosemirror-model",
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-transform",
      "prosemirror-keymap",
      "prosemirror-commands",
      "prosemirror-schema-list",
      "yjs",
      "y-prosemirror",
    ],
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true
      },
      "/mcp": {
        target: backendTarget,
        changeOrigin: true
      },
      "/.well-known": {
        target: backendTarget,
        changeOrigin: true
      },
      "/oauth": {
        target: backendTarget,
        changeOrigin: true
      },
      "/ws": {
        target: backendWsTarget,
        ws: true
      }
    }
  }
});
