import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type {
  JsonObject,
  JsonValue,
  WsClientMessage,
  WsServerEvent,
  ClientInstanceId,
  ImpairmentReport,
} from "../types/shared.js";
import { DocPath, expectJsonObject, parseJson } from "../types/shared.js";
import { resolveAuthenticatedWriterFromHeaders, type AuthenticatedWriter } from "../auth/context.js";
import { checkDocPermission } from "../auth/acl.js";
import { getCurrentFatal, handleProcessFatal } from "../runtime/fatal-handler.js";
import { getCurrentImpairments, pruneResolvedImpairments } from "../runtime/impairment-registry.js";
import { getSystemState } from "../startup-state.js";
import { sendDocumentActivitySnapshot } from "./document-activity.js";

interface SocketState {
  writer: AuthenticatedWriter;
  writerId: string;
  writerDisplayName: string;
  openDocPaths: Set<DocPath>;
  // Stable per-tab identities supplied by the client. Used ONLY for private
  // origin-only routing (see `sendPrivate`) — the ordinary broadcast path
  // does not consult this field. `identify` adds; `tab_gone` removes.
  clientInstanceIds: Set<ClientInstanceId>;
  outbox: Promise<void>;
}

export type DeliveryScope =
  | { kind: "system" }
  | { kind: "catalog"; paths: DocPath[] }
  | { kind: "document"; docPath: DocPath }
  | { kind: "open-document"; docPath: DocPath };

export function deliveryScopeOf(event: WsServerEvent): DeliveryScope {
  switch (event.type) {
    case "system:fatal":
    case "system:impairment":
    case "system:impairment-cleared":
    case "system:impairment-snapshot":
      return { kind: "system" };
    case "catalog:changed":
      return {
        kind: "catalog",
        paths: [...new Set([...(event.added_doc_paths ?? []), ...(event.removed_doc_paths ?? [])])],
      };
    case "doc:renamed":
      return { kind: "catalog", paths: [event.old_path, event.new_path] };
    case "content:committed":
    case "doc:structure-changed":
    case "proposal:draft":
    case "proposal:inprogress":
    case "proposal:withdrawn":
    case "agent:reading":
    case "section:blocked":
    case "section:unblocked":
    case "section:gone":
    case "section:pending":
    case "section:settled":
    case "proposal:section-availability":
      return { kind: "document", docPath: event.doc_path };
    case "presence:editing":
    case "presence:done":
      return { kind: "document", docPath: DocPath.parse(event.doc_path) };
    case "document:activity":
      return { kind: "open-document", docPath: event.doc_path };
    case "section:edit-rejected":
      throw new Error("section:edit-rejected never goes through broadcast");
    default: {
      const _exhaustive: never = event;
      throw new Error(`unhandled event type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export async function stripImpairmentForWriter(
  report: ImpairmentReport,
  writer: AuthenticatedWriter,
): Promise<ImpairmentReport> {
  const doc_paths: DocPath[] = [];
  for (const docPath of report.doc_paths) {
    if (await checkDocPermission(writer, docPath, "read")) {
      doc_paths.push(docPath);
    }
  }
  const targets = [];
  for (const target of report.targets) {
    if (await checkDocPermission(writer, target.doc_path, "read")) {
      targets.push(target);
    }
  }
  return { ...report, doc_paths, targets };
}

export interface WsHub {
  broadcast(event: WsServerEvent): void;
  /**
   * Deliver an origin-only app event (e.g. `section:edit-rejected`) to every
   * open socket whose tab-id set contains `clientInstanceId`. Silently drops
   * the event when no socket matches — the origin tab may have already closed,
   * and re-broadcasting to compensate would leak the rejection into every
   * other tab. Never routes by `writer_id`.
   */
  sendPrivate(
    target: { clientInstanceId: ClientInstanceId },
    event: WsServerEvent,
  ): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * Decode a hub client message at the JSON trust boundary.
 *
 * Malformed input THROWS (full message): `parseJson` carries its own `SyntaxError`
 * for non-JSON, `expectJsonObject` throws for non-objects, and a doc-open
 * command with a non-string path throws naming the field — none are swallowed.
 *
 * Returns `null` ONLY for a well-formed message that is not a doc-open command
 * (the frontend also sends `{ type: "document_focus" | "document_blur" }` over this
 * same socket; the hub does not own those and ignores them). That is NOT an error
 * swallow — it is a different, valid message class outside `WsClientMessage`.
 */
function decodeWsClientMessage(value: JsonValue): WsClientMessage | null {
  const obj: JsonObject = expectJsonObject(value, "hub client message");

  const action = obj["action"];
  if (action === "document_open") {
    const docPath = obj["doc_path"];
    if (typeof docPath !== "string") {
      throw new Error(`hub client message "${action}" requires a string doc_path, got ${JSON.stringify(docPath)}`);
    }
    const rawInstanceId = obj["clientInstanceId"];
    const clientInstanceId = typeof rawInstanceId === "string" ? rawInstanceId : undefined;
    return { action, doc_path: docPath, clientInstanceId };
  }
  if (action === "document_closed") {
    const docPath = obj["doc_path"];
    if (typeof docPath !== "string") {
      throw new Error(`hub client message "${action}" requires a string doc_path, got ${JSON.stringify(docPath)}`);
    }
    return { action, doc_path: docPath };
  }
  if (action === "identify") {
    const rawInstanceId = obj["clientInstanceId"];
    if (typeof rawInstanceId !== "string") {
      throw new Error(`hub client message "identify" requires a string clientInstanceId`);
    }
    return { action, clientInstanceId: rawInstanceId };
  }
  if (action === "tab_gone") {
    const rawInstanceId = obj["clientInstanceId"];
    if (typeof rawInstanceId !== "string") {
      throw new Error(`hub client message "tab_gone" requires a string clientInstanceId`);
    }
    return { action, clientInstanceId: rawInstanceId };
  }

  // Top-level document_open/document_closed key form — the shape the frontend actually sends.
  const documentOpen = obj["document_open"];
  if (typeof documentOpen === "string") {
    return { action: "document_open", doc_path: documentOpen };
  }
  const documentClosed = obj["document_closed"];
  if (typeof documentClosed === "string") {
    return { action: "document_closed", doc_path: documentClosed };
  }

  // Well-formed, but not a doc-open command (e.g. document focus/blur). Not
  // this hub's concern — ignored without throwing.
  return null;
}

function enqueueSocketJob(
  socket: WebSocket,
  state: SocketState,
  job: () => Promise<void> | void,
): void {
  state.outbox = state.outbox
    .then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      await job();
    })
    .then(undefined, (err: unknown) => {
      handleProcessFatal(err, "uncaughtException");
    });
}

function assertDocumentScopedSectionsMatch(event: WsServerEvent): void {
  if (event.type !== "content:committed" && event.type !== "proposal:section-availability") {
    return;
  }
  for (const section of event.sections) {
    if (section.doc_path !== event.doc_path) {
      throw new Error(
        `${event.type} sections contain doc_path ${JSON.stringify(section.doc_path)} which differs from event.doc_path ${JSON.stringify(event.doc_path)}`,
      );
    }
  }
}

async function filterReadableDocPaths(
  writer: AuthenticatedWriter,
  paths: DocPath[] | undefined,
): Promise<DocPath[] | undefined> {
  if (paths === undefined) return undefined;
  const readable: DocPath[] = [];
  for (const path of paths) {
    if (await checkDocPermission(writer, path, "read")) {
      readable.push(path);
    }
  }
  return readable;
}

export function createWsHub(): WsHub {
  const wsServer = new WebSocketServer({ noServer: true });
  const socketState = new Map<WebSocket, SocketState>();

  const hasOpenDocument = (state: SocketState, docPath: DocPath): boolean =>
    state.openDocPaths.has(docPath);

  const broadcastInternal = (event: WsServerEvent) => {
    const scope = deliveryScopeOf(event);
    if (scope.kind === "document") {
      assertDocumentScopedSectionsMatch(event);
    }
    const encoded = JSON.stringify(event);

    for (const [socket, state] of socketState.entries()) {
      switch (scope.kind) {
        case "system":
          enqueueSocketJob(socket, state, async () => {
            if (event.type === "system:impairment") {
              const report = await stripImpairmentForWriter(event.report, state.writer);
              socket.send(JSON.stringify({ ...event, report }));
              return;
            }
            if (event.type === "system:impairment-snapshot") {
              const reports = [];
              for (const report of event.reports) {
                reports.push(await stripImpairmentForWriter(report, state.writer));
              }
              socket.send(JSON.stringify({ ...event, reports }));
              return;
            }
            socket.send(encoded);
          });
          break;
        case "catalog":
          if (event.type === "catalog:changed") {
            enqueueSocketJob(socket, state, async () => {
              const added_doc_paths = await filterReadableDocPaths(state.writer, event.added_doc_paths);
              const removed_doc_paths = await filterReadableDocPaths(state.writer, event.removed_doc_paths);
              if ((added_doc_paths?.length ?? 0) === 0 && (removed_doc_paths?.length ?? 0) === 0) {
                return;
              }
              socket.send(JSON.stringify({
                ...event,
                added_doc_paths,
                removed_doc_paths,
              }));
            });
            break;
          }
          if (event.type === "doc:renamed") {
            enqueueSocketJob(socket, state, async () => {
              const canReadOld = await checkDocPermission(state.writer, event.old_path, "read");
              const canReadNew = await checkDocPermission(state.writer, event.new_path, "read");
              if (!canReadOld && !canReadNew) return;
              socket.send(encoded);
            });
            break;
          }
          throw new Error(`catalog delivery scope used for unexpected event type ${event.type}`);
        case "document":
          enqueueSocketJob(socket, state, async () => {
            if (!(await checkDocPermission(state.writer, scope.docPath, "read"))) return;
            socket.send(encoded);
          });
          break;
        case "open-document":
          enqueueSocketJob(socket, state, () => {
            if (!hasOpenDocument(state, scope.docPath)) return;
            socket.send(encoded);
          });
          break;
        default: {
          const _exhaustive: never = scope;
          throw new Error(`unhandled delivery scope: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
  };

  wsServer.on("connection", (socket, request) => {
    const writer = resolveAuthenticatedWriterFromHeaders(request.headers);
    if (!writer) {
      socket.close(1008, "unauthorized");
      return;
    }

    const state: SocketState = {
      writer,
      writerId: writer.id,
      writerDisplayName: writer.displayName,
      openDocPaths: new Set<DocPath>(),
      clientInstanceIds: new Set<ClientInstanceId>(),
      outbox: Promise.resolve(),
    };
    socketState.set(socket, state);

    // Sticky-fatal replay, two sources: the lifecycle state's RETAINED report
    // (the durable fatal.json latch — covers tabs opened after Docker restarted
    // the backend into the latched state) and the in-process report-mode sticky
    // fatal. Send to just this new socket immediately — no open document is
    // required because the event is system-scoped (no doc_path).
    const currentFatal = getSystemState().fatal ?? getCurrentFatal();
    if (currentFatal) {
      const stickyEvent: WsServerEvent = { type: "system:fatal", report: currentFatal };
      enqueueSocketJob(socket, state, () => {
        socket.send(JSON.stringify(stickyEvent));
      });
    }

    void pruneResolvedImpairments().then(() => {
      enqueueSocketJob(socket, state, async () => {
        const reports = [];
        for (const report of getCurrentImpairments()) {
          reports.push(await stripImpairmentForWriter(report, state.writer));
        }
        const snapshot: WsServerEvent = {
          type: "system:impairment-snapshot",
          reports,
        };
        socket.send(JSON.stringify(snapshot));
      });
    });

    // Read-ACL check + initial activity snapshot make doc-open handling async;
    // the per-socket chain keeps document_open/document_closed ordering intact.
    let docOpenCommandChain: Promise<void> = Promise.resolve();
    const closeSocketAndReportDocOpenCommandFailure = (err: unknown): void => {
      socket.close(1011, "internal error");
      handleProcessFatal(err, "uncaughtException");
    };
    socket.on("message", (data) => {
      const current = socketState.get(socket);
      if (!current) return;

      // Decode at the trust boundary: malformed input throws (propagates — never
      // swallowed); a non-doc-open message decodes to null and is ignored.
      const message = decodeWsClientMessage(parseJson(String(data)));
      if (message === null) return;

      if (message.action === "document_open") {
        docOpenCommandChain = docOpenCommandChain
          .then(async () => {
            const docPath = DocPath.parse(message.doc_path);
            const canRead = await checkDocPermission(current.writer, docPath, "read");
            if (!canRead) return;
            current.openDocPaths.add(docPath);
            await sendDocumentActivitySnapshot(docPath, (event) => {
              enqueueSocketJob(socket, current, () => {
                socket.send(JSON.stringify(event));
              });
            });
          })
          .then(null, closeSocketAndReportDocOpenCommandFailure);
        return;
      }
      if (message.action === "identify") {
        current.clientInstanceIds.add(message.clientInstanceId);
        return;
      }
      if (message.action === "tab_gone") {
        current.clientInstanceIds.delete(message.clientInstanceId);
        return;
      }
      docOpenCommandChain = docOpenCommandChain
        .then(() => {
          current.openDocPaths.delete(DocPath.parse(message.doc_path));
        })
        .then(null, closeSocketAndReportDocOpenCommandFailure);
    });

    socket.on("close", () => {
      socketState.delete(socket);
    });
  });

  const sendPrivateInternal = (
    target: { clientInstanceId: ClientInstanceId },
    event: WsServerEvent,
  ): void => {
    // Wrap the event in a private envelope so the shared-worker layer can
    // filter it to the ONE tab whose `clientInstanceId` matches, even when
    // that tab shares a leader WebSocket with other tabs of the same writer.
    // The envelope is unwrapped in `frontend/src/workers/ws-shared-worker.ts`
    // (`forwardPrivateEnvelope`) before delivery to a tab port; other tabs
    // never observe the payload.
    const envelope = JSON.stringify({
      __private__: true as const,
      target_client_instance_id: target.clientInstanceId,
      event,
    });
    const eventDocPath =
      "doc_path" in event && typeof event.doc_path === "string"
        ? DocPath.parse(event.doc_path)
        : null;
    for (const [socket, state] of socketState.entries()) {
      if (!state.clientInstanceIds.has(target.clientInstanceId)) continue;
      enqueueSocketJob(socket, state, () => {
        if (!state.clientInstanceIds.has(target.clientInstanceId)) return;
        if (eventDocPath !== null) {
          const openedThisDocument = hasOpenDocument(state, eventDocPath);
          const noOpenDocuments = state.openDocPaths.size === 0;
          if (!openedThisDocument && !noOpenDocuments) return;
        }
        socket.send(envelope);
      });
    }
  };

  return {
    broadcast(event) {
      broadcastInternal(event);
    },
    sendPrivate(target, event) {
      sendPrivateInternal(target, event);
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        wsServer.emit("connection", ws, request);
      });
    },
  };
}
