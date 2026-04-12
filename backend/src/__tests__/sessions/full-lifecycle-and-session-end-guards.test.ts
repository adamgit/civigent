import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { createApp } from "../../app.js";
import { setSystemReady } from "../../startup-state.js";
import { createCrdtWsServer } from "../../ws/crdt-sync.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { issueTokenPair } from "../../auth/tokens.js";
import {
  MSG_MODE_TRANSITION_REQUEST,
  MSG_MODE_TRANSITION_RESULT,
  MSG_MUTATE_RESULT,
  MSG_SECTION_MUTATE,
  MSG_SESSION_OVERLAY_IMPORTED,
  MSG_SYNC_STEP_2,
  MSG_YJS_UPDATE,
  MSG_SESSION_OVERLAY_IMPORT_REQUEST,
} from "../../ws/crdt-protocol.js";
import { commitDirtySections } from "../../storage/auto-commit.js";
import type { WriterIdentity, ModeTransitionResult, ModeTransitionRequest } from "../../types/shared.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import {
  acquireDocSession,
  releaseDocSession,
  markFragmentDirty,
  flushAndDestroyAll,
  setSessionOverlayImportCallback,
  destroyAllSessions,
  flushDirtyToOverlay,
} from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { getContentRoot, getDataRoot, getSessionSectionsContentRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { rm } from "node:fs/promises";
import path from "node:path";

async function cleanupSessionOverlay(docPath: string): Promise<void> {
  const overlayRoot = getSessionSectionsContentRoot();
  const skelPath = path.join(overlayRoot, ...docPath.split("/"));
  await rm(skelPath, { force: true });
  await rm(`${skelPath}.sections`, { recursive: true, force: true });
  const fragDir = path.join(getSessionFragmentsRoot(), docPath);
  await rm(fragDir, { recursive: true, force: true });
}

async function commitToCanonical(writers: WriterIdentity[], docPath: string) {
  const store = new CanonicalStore(getContentRoot(), getDataRoot());
  const [primary] = writers;
  const commitMsg = `human edit: ${primary.displayName}\n\nWriter: ${primary.id}`;
  const author = { name: primary.displayName, email: primary.email ?? "human@knowledge-store.local" };
  return store.absorbChangedSections(getSessionSectionsContentRoot(), commitMsg, author, { docPaths: [docPath] });
}

function rawToUint8Array(raw: WebSocket.RawData): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  return new Uint8Array(raw as Buffer);
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Uint8Array) => boolean,
  timeoutMs = 4000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const msg = rawToUint8Array(raw);
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before expected message"));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

async function waitForOpen(ws: WebSocket, timeoutMs = 4000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket open"));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.on("open", onOpen);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  const msg = new Uint8Array(1 + payload.length);
  msg[0] = type;
  msg.set(payload, 1);
  return msg;
}

async function requestModeTransition(
  ws: WebSocket,
  request: ModeTransitionRequest,
): Promise<ModeTransitionResult> {
  ws.send(encodeMessage(MSG_MODE_TRANSITION_REQUEST, new TextEncoder().encode(JSON.stringify(request))));
  const resultMsg = await waitForMessage(ws, (msg) => msg[0] === MSG_MODE_TRANSITION_RESULT);
  const parsed = JSON.parse(new TextDecoder().decode(resultMsg.subarray(1))) as ModeTransitionResult;
  if (parsed.requestId !== request.requestId) {
    throw new Error(`Unexpected mode transition response: expected ${request.requestId}, got ${parsed.requestId}`);
  }
  return parsed;
}

async function sendSectionMutate(
  ws: WebSocket,
  fragmentKey: string,
  markdown: string,
): Promise<{ success: boolean; error?: string }> {
  const payload = new TextEncoder().encode(JSON.stringify({ fragmentKey, markdown }));
  ws.send(encodeMessage(MSG_SECTION_MUTATE, payload));
  const resultMsg = await waitForMessage(ws, (msg) => msg[0] === MSG_MUTATE_RESULT);
  return JSON.parse(new TextDecoder().decode(resultMsg.subarray(1))) as { success: boolean; error?: string };
}

async function fetchSections(app: ReturnType<typeof createApp>, bearerToken: string) {
  const response = await request(app)
    .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
    .set("Authorization", `Bearer ${bearerToken}`);
  expect(response.status).toBe(200);
  return response.body.sections as Array<{
    heading: string;
    heading_path: string[];
    content: string;
    fragment_key: string;
  }>;
}

function headingKey(headingPath: string[]): string {
  return headingPath.join(">>");
}

function sectionMap(sections: Array<{ heading_path: string[]; content: string }>): Map<string, string> {
  return new Map(sections.map((section) => [headingKey(section.heading_path), section.content]));
}

describe("full lifecycle + session-end normalization guardrails", () => {
  let ctx: TempDataRootContext;
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let port: number;
  let writer: WriterIdentity;
  let writerToken: string;
  let openSockets: WebSocket[] = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setSystemReady();
    app = createApp();

    const crdtWs = createCrdtWsServer();
    server = createServer(app);
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
      if (pathname.startsWith("/ws/crdt/")) {
        crdtWs.handleUpgrade(request, socket, head);
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });

    writer = {
      id: "lifecycle-writer",
      type: "human",
      displayName: "Lifecycle Writer",
      email: "lifecycle-writer@test.local",
    };
    writerToken = issueTokenPair({
      id: writer.id,
      type: writer.type,
      displayName: writer.displayName,
    }).access_token;
  });

  afterEach(async () => {
    destroyAllSessions();
    for (const s of openSockets) { if (s.readyState === WebSocket.OPEN) s.close(); }
    openSockets = [];
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.cleanup();
  });

  it("publish-then-detach lifecycle should preserve full document content", async () => {
    const clientInstanceId = "client-publish-detach";
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${clientInstanceId}`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(ws);
    await waitForOpen(ws);

    // Register SYNC_STEP_2 listener BEFORE the mode transition, because
    // joinAndNotify sends SYNC_STEP_2 before the mode transition result.
    const syncPromise = waitForMessage(ws, (msg) => msg[0] === MSG_SYNC_STEP_2);
    const editorResult = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "editor",
      editorFocusTarget: null,
    });
    expect(editorResult.kind).toBe("success");

    await syncPromise;

    const sectionsBefore = await fetchSections(app, writerToken);
    const overview = sectionsBefore.find((section) => section.heading === "Overview");
    expect(overview).toBeDefined();

    const mutate = await sendSectionMutate(
      ws,
      overview!.fragment_key,
      `${overview!.content}\n\nLifecycle publish-detach line.`,
    );
    expect(mutate.success).toBe(true);

    const publishResult = await commitDirtySections(writer, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(publishResult.committed).toBe(true);

    const noneResult = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "none",
      editorFocusTarget: null,
    });
    expect(noneResult.kind).toBe("success");

    ws.close();

    const sectionsAfter = await fetchSections(app, writerToken);
    const overviewAfter = sectionsAfter.find((section) => section.heading === "Overview");
    const rootAfter = sectionsAfter.find((section) => section.heading_path.length === 0);
    expect(overviewAfter?.content).toContain("Lifecycle publish-detach line.");
    expect(rootAfter?.content.trim().length).toBeGreaterThan(0);
    expect(sectionsAfter.some((section) => section.heading === "Timeline")).toBe(true);
  });

  it("mode-switch replay editor->none->observer->none->editor should not collapse structure", async () => {
    const clientInstanceId = "client-mode-replay";
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${clientInstanceId}`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(ws);
    await waitForOpen(ws);

    const editor = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "editor",
      editorFocusTarget: null,
    });
    expect(editor.kind).toBe("success");

    const none1 = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "none",
      editorFocusTarget: null,
    });
    expect(none1.kind).toBe("success");

    const observer = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "observer",
      editorFocusTarget: null,
    });
    expect(observer.kind).toBe("success");

    const none2 = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "none",
      editorFocusTarget: null,
    });
    expect(none2.kind).toBe("success");

    const editorAgain = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "editor",
      editorFocusTarget: null,
    });
    expect(editorAgain.kind).toBe("success");

    ws.close();
    const sections = await fetchSections(app, writerToken);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(sections.filter((section) => section.heading === "Overview").length).toBe(1);
    expect(sections.filter((section) => section.heading === "Timeline").length).toBe(1);
  });

  it("governance read-path parity: /sections content should match canonical assembled content", async () => {
    const clientInstanceId = "client-governance-parity";
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${clientInstanceId}`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(ws);
    await waitForOpen(ws);
    await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "editor",
      editorFocusTarget: null,
    });

    const sectionsBefore = await fetchSections(app, writerToken);
    const overview = sectionsBefore.find((section) => section.heading === "Overview");
    expect(overview).toBeDefined();
    const mutate = await sendSectionMutate(
      ws,
      overview!.fragment_key,
      `${overview!.content}\n\nGovernance parity additional line.`,
    );
    expect(mutate.success).toBe(true);

    const publishResult = await commitDirtySections(writer, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(publishResult.committed).toBe(true);
    await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "none",
      editorFocusTarget: null,
    });
    ws.close();

    const sectionsAfter = await fetchSections(app, writerToken);
    const canonicalLayer = new ContentLayer(ctx.contentDir);
    const assembled = await canonicalLayer.readAssembledDocument(SAMPLE_DOC_PATH);

    for (const section of sectionsAfter) {
      if (!section.content.trim()) continue;
      expect(assembled).toContain(section.content.trim());
    }

    const overviewAfter = sectionsAfter.find((section) => section.heading === "Overview");
    expect(overviewAfter?.content).toContain("Governance parity additional line.");
    expect(overviewAfter?.content).toContain("Overview");
  });

  it("no-focus YJS update path should still preserve untouched sections across publish+detach", async () => {
    const clientInstanceId = "client-no-focus-yjs";
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${clientInstanceId}`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(ws);
    await waitForOpen(ws);

    // Register SYNC_STEP_2 listener BEFORE the mode transition, because
    // joinAndNotify sends SYNC_STEP_2 before the mode transition result.
    const syncPromise = waitForMessage(ws, (msg) => msg[0] === MSG_SYNC_STEP_2);
    await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "editor",
      editorFocusTarget: null,
    });
    const syncMsg = await syncPromise;

    const sectionsBefore = await fetchSections(app, writerToken);
    const overview = sectionsBefore.find((section) => section.heading === "Overview");
    const timelineBefore = sectionsBefore.find((section) => section.heading === "Timeline");
    expect(overview).toBeDefined();
    expect(timelineBefore).toBeDefined();

    // Build a client-side Y.Doc from the server's sync state (not from disk).
    // An independently-constructed Y.Doc has different Y.js item IDs, so
    // clearFragment deletes would be no-ops when applied cross-doc, causing
    // duplicate content.
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, syncMsg.subarray(1));
    const svBefore = Y.encodeStateVector(clientDoc);

    // Clear the existing fragment (same approach as DocumentFragments.clearFragment)
    const fragment = clientDoc.getXmlFragment(overview!.fragment_key);
    clientDoc.transact(() => { while (fragment.length > 0) fragment.delete(0, 1); });

    // Populate with new content (same approach as DocumentFragments.populateFragment)
    const newMarkdown = `${overview!.content}\n\nNo-focus YJS path line.`;
    const pmJson = markdownToJSON(newMarkdown);
    const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, overview!.fragment_key);
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(tempDoc));
    tempDoc.destroy();

    const payload = Y.encodeStateAsUpdate(clientDoc, svBefore);

    ws.send(encodeMessage(MSG_YJS_UPDATE, payload));
    ws.send(encodeMessage(MSG_SESSION_OVERLAY_IMPORT_REQUEST, new Uint8Array(0)));
    await waitForMessage(ws, (msg) => msg[0] === MSG_SESSION_OVERLAY_IMPORTED);

    const publishResult = await commitDirtySections(writer, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(publishResult.committed).toBe(true);

    await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "none",
      editorFocusTarget: null,
    });
    ws.close();

    const sectionsAfter = await fetchSections(app, writerToken);
    const overviewAfter = sectionsAfter.find((section) => section.heading === "Overview");
    const timelineAfter = sectionsAfter.find((section) => section.heading === "Timeline");
    expect(overviewAfter?.content).toContain("No-focus YJS path line.");
    expect(timelineAfter?.content).toBe(timelineBefore!.content);
  });

  it("observer should be closed with session-ended code when last editor disconnects", async () => {
    const editorClient = "client-observer-editor";
    const observerClient = "client-observer-only";

    const editorWs = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${editorClient}`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(editorWs);
    await waitForOpen(editorWs);
    await requestModeTransition(editorWs, {
      requestId: crypto.randomUUID(),
      clientInstanceId: editorClient,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "editor",
      editorFocusTarget: null,
    });

    const observerWs = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${observerClient}`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(observerWs);
    await waitForOpen(observerWs);
    await requestModeTransition(observerWs, {
      requestId: crypto.randomUUID(),
      clientInstanceId: observerClient,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "observer",
      editorFocusTarget: null,
    });

    const observerClose = new Promise<{ code: number }>((resolve) => {
      observerWs.once("close", (code) => resolve({ code }));
    });

    editorWs.close();
    const close = await observerClose;
    expect(close.code).toBe(4021);

    const newObserver = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=client-observer-reopen`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(newObserver);
    await waitForOpen(newObserver);
    const result = await requestModeTransition(newObserver, {
      requestId: crypto.randomUUID(),
      clientInstanceId: "client-observer-reopen",
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "observer",
      editorFocusTarget: null,
    });
    expect(result.kind).toBe("success");
    newObserver.close();
  });

  it("untouched section content should remain identical across publish->detach checkpoints", async () => {
    const beforeSections = await fetchSections(app, writerToken);
    const beforeMap = sectionMap(beforeSections.map((s) => ({ heading_path: s.heading_path, content: s.content })));

    const clientInstanceId = "client-boundary";
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${clientInstanceId}`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(ws);
    await waitForOpen(ws);
    await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "editor",
      editorFocusTarget: null,
    });

    const overview = beforeSections.find((section) => section.heading === "Overview");
    expect(overview).toBeDefined();
    const mutate = await sendSectionMutate(
      ws,
      overview!.fragment_key,
      `${overview!.content}\n\nCommit boundary line.`,
    );
    expect(mutate.success).toBe(true);
    const publish = await commitDirtySections(writer, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(publish.committed).toBe(true);

    const afterPublishSections = await fetchSections(app, writerToken);
    const afterPublishMap = sectionMap(afterPublishSections.map((s) => ({ heading_path: s.heading_path, content: s.content })));

    await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "none",
      editorFocusTarget: null,
    });
    ws.close();

    const afterDetachSections = await fetchSections(app, writerToken);
    const afterDetachMap = sectionMap(afterDetachSections.map((s) => ({ heading_path: s.heading_path, content: s.content })));

    for (const [key, before] of beforeMap) {
      if (key === "Overview") continue;
      expect(afterPublishMap.get(key)).toBe(before);
      expect(afterDetachMap.get(key)).toBe(before);
    }
  });

  it("session-end should normalize only explicitly dirty keys (future guardrail)", async () => {
    setSessionOverlayImportCallback(async (session) => {
      await flushDirtyToOverlay(session);
    });

    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-scope-guard",
    );

    let overviewKey: string | null = null;
    let timelineKey: string | null = null;
    for (const [fragmentKey, headingPath] of session.headingPathByFragmentKey) {
      const heading = headingPath[headingPath.length - 1] ?? "";
      if (heading === "Overview") overviewKey = fragmentKey;
      if (heading === "Timeline") timelineKey = fragmentKey;
    }
    expect(overviewKey).not.toBeNull();
    expect(timelineKey).not.toBeNull();

    markFragmentDirty(SAMPLE_DOC_PATH, writer.id, overviewKey!);
    session.liveFragments.noteAheadOfStaged(overviewKey!);

    // Spy on stagedSections.acceptLiveFragments to capture normalization scope.
    // normalizeFragmentKeys now calls stores directly instead of fragments.normalizeStructure.
    const normalizedKeys: string[] = [];
    const stagedAny = session.stagedSections as any;
    const originalAccept = stagedAny.acceptLiveFragments.bind(session.stagedSections);
    stagedAny.acceptLiveFragments = async (liveStore: unknown, scope: ReadonlySet<string>) => {
      for (const key of scope) normalizedKeys.push(key);
      return originalAccept(liveStore, scope);
    };

    try {
      const released = await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-scope-guard");
      expect(released.sessionEnded).toBe(true);
    } finally {
      stagedAny.acceptLiveFragments = originalAccept;
    }

    expect(new Set(normalizedKeys)).toEqual(new Set([overviewKey!]));
    expect(normalizedKeys).not.toContain(timelineKey!);
  });

  it("detach commit should not restructure untouched malformed sibling section", async () => {
    setSessionOverlayImportCallback(async (session) => {
      await flushDirtyToOverlay(session);
    });

    const baseHead = await getHeadSha(ctx.rootDir);
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: {
        writerId: writer.id,
        identity: writer,
        socketId: "sock-detach-preserve",
      },
    });

    const sections = await fetchSections(app, writerToken);
    const overview = sections.find((section) => section.heading === "Overview");
    const timeline = sections.find((section) => section.heading === "Timeline");
    expect(overview).toBeDefined();
    expect(timeline).toBeDefined();

    live.liveFragments.replaceFragmentString(overview!.fragment_key, fragmentFromRemark(`${overview!.content}\n\nDetach preserve edit.`), undefined);
    live.liveFragments.noteAheadOfStaged(overview!.fragment_key);
    markFragmentDirty(SAMPLE_DOC_PATH, writer.id, overview!.fragment_key);

    // Untouched malformed sibling
    live.liveFragments.replaceFragmentString(
      timeline!.fragment_key,
      fragmentFromRemark("Timeline malformed sibling that should never become canonical."),
      undefined,
    );

    const released = await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-detach-preserve");
    expect(released.sessionEnded).toBe(true);

    const commitResult = await commitToCanonical([writer], SAMPLE_DOC_PATH);
    if (commitResult.changedSections.length > 0) {
      await cleanupSessionOverlay(SAMPLE_DOC_PATH);
    }

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(SAMPLE_SECTIONS.timeline);
    expect(assembled).not.toContain("Timeline malformed sibling that should never become canonical.");
  });

  it("flushAndDestroyAll should not perform implicit global normalization sweep (future guardrail)", async () => {
    setSessionOverlayImportCallback(async (session) => {
      await flushDirtyToOverlay(session);
    });

    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-shutdown-guard",
    );

    let overviewKey: string | null = null;
    let timelineKey: string | null = null;
    for (const [fragmentKey, headingPath] of session.headingPathByFragmentKey) {
      const heading = headingPath[headingPath.length - 1] ?? "";
      if (heading === "Overview") overviewKey = fragmentKey;
      if (heading === "Timeline") timelineKey = fragmentKey;
    }
    expect(overviewKey).not.toBeNull();
    expect(timelineKey).not.toBeNull();

    markFragmentDirty(SAMPLE_DOC_PATH, writer.id, overviewKey!);
    session.liveFragments.noteAheadOfStaged(overviewKey!);

    // Spy on stagedSections.acceptLiveFragments to capture normalization scope.
    // normalizeFragmentKeys now calls stores directly instead of fragments.normalizeStructure.
    const normalizedKeys: string[] = [];
    const stagedAny = session.stagedSections as any;
    const originalAccept = stagedAny.acceptLiveFragments.bind(session.stagedSections);
    stagedAny.acceptLiveFragments = async (liveStore: unknown, scope: ReadonlySet<string>) => {
      for (const key of scope) normalizedKeys.push(key);
      return originalAccept(liveStore, scope);
    };

    try {
      await flushAndDestroyAll();
    } finally {
      stagedAny.acceptLiveFragments = originalAccept;
    }

    expect(new Set(normalizedKeys)).toEqual(new Set([overviewKey!]));
    expect(normalizedKeys).not.toContain(timelineKey!);
  });
});
