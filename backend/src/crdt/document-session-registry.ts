import type { WriterIdentity } from "../types/shared.js";
import {
  acquireDocSession,
  getAllSessions,
  getDocSessionId,
  lookupDocSession,
  rekeyDocSession,
} from "./ydoc-lifecycle.js";
import { LiveDocumentSession } from "./live-document-session.js";
import type { DocSession } from "./ydoc-lifecycle.js";

export interface SessionParticipant {
  writerId: string;
  identity: WriterIdentity;
  socketId?: string;
}

export class DocumentSessionRegistry {
  private readonly wrappers = new WeakMap<DocSession, LiveDocumentSession>();

  get(docPath: string): LiveDocumentSession | undefined {
    const session = lookupDocSession(docPath);
    if (!session) return undefined;
    return this.wrap(session);
  }

  getSessionId(docPath: string): string | null {
    return getDocSessionId(docPath);
  }

  getAll(): Iterable<LiveDocumentSession> {
    const all = getAllSessions();
    const sessions: LiveDocumentSession[] = [];
    for (const session of all.values()) {
      sessions.push(this.wrap(session));
    }
    return sessions;
  }

  async getOrCreate(params: {
    docPath: string;
    baseHead: string;
    initialEditor: SessionParticipant;
  }): Promise<LiveDocumentSession> {
    const session = await acquireDocSession(
      params.docPath,
      params.initialEditor.writerId,
      params.baseHead,
      params.initialEditor.identity,
      params.initialEditor.socketId,
    );
    return this.wrap(session);
  }

  rekey(oldPath: string, newPath: string): void {
    rekeyDocSession(oldPath, newPath);
  }

  remove(_docPath: string): void {
    // Removal remains lifecycle-owned (releaseDocSession / invalidateForRestore).
  }

  private wrap(session: DocSession): LiveDocumentSession {
    const existing = this.wrappers.get(session);
    if (existing) return existing;
    const wrapped = new LiveDocumentSession(session);
    this.wrappers.set(session, wrapped);
    return wrapped;
  }
}

export const documentSessionRegistry = new DocumentSessionRegistry();

