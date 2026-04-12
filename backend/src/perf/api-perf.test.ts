/**
 * Performance smoke tests — hit the real dev-data and assert response times
 * are within a reasonable bound (< 10 s).
 *
 * Run in isolation:
 *   cd backend && npx vitest run src/perf/
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import path from "node:path";
import { createApp } from "../app.js";
import { setSystemReady } from "../startup-state.js";
import { ensureGitRepoReady, getHeadSha } from "../storage/git-repo.js";
import { ensureV3Directories, getDataRoot } from "../storage/data-root.js";
import { acquireDocSession, releaseDocSession, lookupDocSession, setSessionOverlayImportCallback, flushDirtyToOverlay } from "../crdt/ydoc-lifecycle.js";
import type { WriterIdentity } from "../types/shared.js";

const PERF_WRITER: WriterIdentity = { id: "perf-writer", type: "human", displayName: "Perf Writer", email: "perf@test.local" };
const DEV_DATA = path.resolve(__dirname, "../../../dev-data");
const MAX_MS = 10_000;

describe("API performance (dev-data)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    process.env.KS_DATA_ROOT = DEV_DATA;
    await ensureV3Directories();
    await ensureGitRepoReady(DEV_DATA);
    setSystemReady();
    app = createApp();
  }, 30_000);

  // ── Helpers ──────────────────────────────────────────────

  async function getDocPaths(count: number): Promise<string[]> {
    const res = await request(app).get("/api/documents/tree");
    expect(res.status).toBe(200);
    const files = collectFiles(res.body.tree);
    expect(files.length).toBeGreaterThanOrEqual(count);
    return files.slice(0, count);
  }

  async function getFirstDocPath(): Promise<string> {
    return (await getDocPaths(1))[0];
  }

  async function loadDocumentPage(docPath: string) {
    const encoded = encodeURIComponent(docPath);
    const [structureRes, sectionsRes, changesRes] = await Promise.all([
      request(app).get(`/api/documents/${encoded}/structure`),
      request(app).get(`/api/documents/${encoded}/sections`),
      request(app).get(`/api/documents/${encoded}/changes-since`),
    ]);
    expect(structureRes.status).toBe(200);
    expect(sectionsRes.status).toBe(200);
    expect(changesRes.status).toBe(200);
  }

  async function enterEditMode(docPath: string, writerId: string) {
    const baseHead = await getHeadSha(getDataRoot());
    await acquireDocSession(docPath, writerId, baseHead, PERF_WRITER);
  }

  // ── Test 1: Sidebar ──────────────────────────────────────

  it("Sidebar: auth/session + documents/tree", async () => {
    const start = performance.now();
    const [sessionRes, treeRes] = await Promise.all([
      request(app).get("/api/auth/session"),
      request(app).get("/api/documents/tree"),
    ]);
    const elapsed = performance.now() - start;

    expect(sessionRes.status).toBe(200);
    expect(treeRes.status).toBe(200);
    expect(Array.isArray(treeRes.body.tree)).toBe(true);
    expect(elapsed).toBeLessThan(MAX_MS);
  }, MAX_MS + 5_000);

  // ── Test 2: DocumentPage load ────────────────────────────

  it("DocumentPage: structure + sections + changes-since", async () => {
    const docPath = await getFirstDocPath();

    const start = performance.now();
    await loadDocumentPage(docPath);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(MAX_MS);
  }, MAX_MS + 5_000);

  // ── Test 3: DocumentPage + enter edit mode ───────────────
  //
  // Entering edit mode triggers acquireDocSession which builds a
  // Y.Doc from all sections (markdown → ProseMirror → Yjs).
  // This is synchronous and CPU-bound, so we call it directly
  // rather than through WebSocket to avoid event-loop starvation.

  it("DocumentPage + enter edit mode (CRDT session acquire)", async () => {
    const docPath = await getFirstDocPath();

    const start = performance.now();
    await loadDocumentPage(docPath);
    await enterEditMode(docPath, "perf-test-3");
    const elapsed = performance.now() - start;

    await releaseDocSession(docPath, "perf-test-3");

    expect(elapsed).toBeLessThan(MAX_MS);
  }, MAX_MS * 3);

  // ── Test 4: DocumentPage + edit mode + reload sidebar ────

  it("DocumentPage + edit mode, then reload sidebar", async () => {
    const docPath = await getFirstDocPath();

    await loadDocumentPage(docPath);
    await enterEditMode(docPath, "perf-test-4");

    // While CRDT session is active, load the root page (sidebar)
    const start = performance.now();
    const [sessionRes, treeRes] = await Promise.all([
      request(app).get("/api/auth/session"),
      request(app).get("/api/documents/tree"),
    ]);
    const elapsed = performance.now() - start;

    await releaseDocSession(docPath, "perf-test-4");

    expect(sessionRes.status).toBe(200);
    expect(treeRes.status).toBe(200);
    expect(Array.isArray(treeRes.body.tree)).toBe(true);
    expect(elapsed).toBeLessThan(MAX_MS);
  }, MAX_MS * 3);

  // ── Test 5: Two docs open in edit mode + documents view ──
  //
  // Simulates two browser tabs each editing a different document,
  // then a third tab opening the documents view.

  it("Two docs editing, then open documents view", async () => {
    const [doc1, doc2] = await getDocPaths(2);

    // 1. Tab 1: load first document + enter edit mode
    await loadDocumentPage(doc1);
    await enterEditMode(doc1, "perf-test-5a");

    // 2. Tab 2: load second document + enter edit mode
    await loadDocumentPage(doc2);
    await enterEditMode(doc2, "perf-test-5b");

    // 3. Open the documents view (sidebar endpoints)
    const start = performance.now();
    const [sessionRes, treeRes] = await Promise.all([
      request(app).get("/api/auth/session"),
      request(app).get("/api/documents/tree"),
    ]);
    const elapsed = performance.now() - start;

    // Cleanup
    await releaseDocSession(doc1, "perf-test-5a");
    await releaseDocSession(doc2, "perf-test-5b");

    expect(sessionRes.status).toBe(200);
    expect(treeRes.status).toBe(200);
    expect(Array.isArray(treeRes.body.tree)).toBe(true);
    expect(elapsed).toBeLessThan(MAX_MS);
  }, MAX_MS * 5);

  // ── Test 6: Flush during active session ─────────────────
  //
  // Exercises the background flush path: assembleMarkdownFromDoc +
  // applyDocumentMarkdownToDraft. Ensures flushing a large doc
  // doesn't block the event loop beyond the budget.

  it("Flush doc doesn't block event loop > budget", async () => {
    setSessionOverlayImportCallback(async (s) => {
      await flushDirtyToOverlay(s);
    });

    const docPath = await getFirstDocPath();
    await enterEditMode(docPath, "perf-test-flush");
    const session = lookupDocSession(docPath)!;
    expect(session).toBeDefined();

    const start = performance.now();
    await flushDirtyToOverlay(session);
    const elapsed = performance.now() - start;

    await releaseDocSession(docPath, "perf-test-flush");

    expect(elapsed).toBeLessThan(MAX_MS);
  }, MAX_MS * 3);
});

// Collect all file paths from the tree in order
function collectFiles(
  entries: Array<{ name: string; path: string; type: string; children?: any[] }>,
): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.type === "file") result.push(entry.path);
    if (entry.children?.length) {
      result.push(...collectFiles(entry.children));
    }
  }
  return result;
}
