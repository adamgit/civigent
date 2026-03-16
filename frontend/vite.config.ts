import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backendTarget = process.env.VITE_BACKEND_TARGET ?? "http://localhost:3000";
const backendUrl = new URL(backendTarget);
const wsProtocol = backendUrl.protocol === "https:" ? "wss:" : "ws:";
const backendWsTarget = `${wsProtocol}//${backendUrl.host}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
