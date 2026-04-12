import type { WriterIdentity } from "../types/shared.js";
import {
  acquireDocSession,
  getAllSessions,
  getDocSessionId,
  lookupDocSession,
  rekeyDocSession,
} from "./ydoc-lifecycle.js";
import type { DocSession } from "./ydoc-lifecycle.js";

export interface SessionParticipant {
  writerId: string;
  identity: WriterIdentity;
  socketId?: string;
}

export class DocumentSessionRegistry {
  get(docPath: string): DocSession | undefined {
    return lookupDocSession(docPath) ?? undefined;
  }

  getSessionId(docPath: string): string | null {
    return getDocSessionId(docPath);
  }

  getAll(): Iterable<DocSession> {
    return getAllSessions().values();
  }

  async getOrCreate(params: {
    docPath: string;
    baseHead: string;
    initialEditor: SessionParticipant;
  }): Promise<DocSession> {
    return acquireDocSession(
      params.docPath,
      params.initialEditor.writerId,
      params.baseHead,
      params.initialEditor.identity,
      params.initialEditor.socketId,
    );
  }

  rekey(oldPath: string, newPath: string): void {
    rekeyDocSession(oldPath, newPath);
  }

  remove(_docPath: string): void {
    // Removal remains lifecycle-owned (releaseDocSession / invalidateForRestore).
  }
}

export const documentSessionRegistry = new DocumentSessionRegistry();
