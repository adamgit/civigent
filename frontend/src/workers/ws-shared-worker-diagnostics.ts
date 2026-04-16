export type WorkerDiagSource = "worker-incoming" | "worker-outgoing" | "worker-lifecycle";

export interface WorkerDiagEntry {
  id: number;
  timestamp: number;
  source: WorkerDiagSource;
  type: string;
  summary: string;
  docPath?: string;
  payload?: unknown;
}

export interface WorkerDiagCaptureInput {
  source: WorkerDiagSource;
  type: string;
  summary: string;
  docPath?: string;
  payload?: unknown;
}

export interface DiagnosticsPort {
  postMessage(message: unknown): void;
}

const BACKLOG_CAPACITY = 50;

export class WorkerDiagnostics {
  private nextId = 1;
  private readonly backlog: WorkerDiagEntry[] = [];
  private readonly subscribers = new Set<DiagnosticsPort>();

  capture(input: WorkerDiagCaptureInput): void {
    const entry: WorkerDiagEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      source: input.source,
      type: input.type,
      summary: input.summary,
      docPath: input.docPath,
      payload: input.payload,
    };
    this.backlog.push(entry);
    if (this.backlog.length > BACKLOG_CAPACITY) {
      this.backlog.splice(0, this.backlog.length - BACKLOG_CAPACITY);
    }
    if (this.subscribers.size === 0) {
      return;
    }
    const message = { type: "diagnostics_event", entry };
    for (const port of this.subscribers) {
      port.postMessage(message);
    }
  }

  subscribe(port: DiagnosticsPort): void {
    if (this.subscribers.has(port)) {
      return;
    }
    this.subscribers.add(port);
    port.postMessage({ type: "diagnostics_backlog", entries: this.backlog.slice() });
  }

  unsubscribe(port: DiagnosticsPort): void {
    this.subscribers.delete(port);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get backlogSize(): number {
    return this.backlog.length;
  }
}
