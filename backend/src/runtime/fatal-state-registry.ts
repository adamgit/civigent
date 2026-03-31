import type { ServerResponse } from "node:http";
import type { FatalReport, SystemState } from "./system-state.js";

/**
 * Retained system lifecycle state + SSE client tracking.
 *
 * The dev-supervisor owns one instance of this. It stores the current
 * lifecycle phase, tracks connected SSE clients, and broadcasts state
 * changes to all of them.
 */
export class FatalStateRegistry {
  private state: SystemState = { state: "starting" };
  private clients = new Set<ServerResponse>();

  getState(): SystemState {
    return this.state;
  }

  setStarting(): void {
    this.state = { state: "starting" };
    this.broadcast();
  }

  setReady(): void {
    this.state = { state: "ready" };
    this.broadcast();
  }

  setFatal(report: FatalReport): void {
    this.state = { state: "fatal", fatal: report };
    this.broadcast();
  }

  addClient(res: ServerResponse): void {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
    this.writeCurrentState(res);
  }

  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
  }

  writeCurrentState(res: ServerResponse): void {
    if (res.destroyed) {
      this.clients.delete(res);
      return;
    }
    const data = JSON.stringify(this.state);
    res.write(`event: system_state\ndata: ${data}\n\n`);
  }

  private broadcast(): void {
    for (const client of this.clients) {
      this.writeCurrentState(client);
    }
  }
}
