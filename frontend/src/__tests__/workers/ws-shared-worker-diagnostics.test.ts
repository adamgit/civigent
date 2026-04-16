import { describe, it, expect, vi } from "vitest";
import { WorkerDiagnostics } from "../../workers/ws-shared-worker-diagnostics";

function makePort() {
  return { postMessage: vi.fn() };
}

describe("WorkerDiagnostics", () => {
  it("appends to internal backlog when capturing", () => {
    const d = new WorkerDiagnostics();
    d.capture({ source: "worker-incoming", type: "x", summary: "" });
    expect(d.backlogSize).toBe(1);
  });

  it("skips postMessage entirely when there are no subscribers", () => {
    const d = new WorkerDiagnostics();
    const orphan = makePort();
    d.capture({ source: "worker-incoming", type: "x", summary: "" });
    expect(orphan.postMessage).not.toHaveBeenCalled();
    expect(d.subscriberCount).toBe(0);
  });

  it("sends the backlog (as a single message) to a newly-subscribed port", () => {
    const d = new WorkerDiagnostics();
    d.capture({ source: "worker-lifecycle", type: "open", summary: "ws://host/ws" });
    d.capture({
      source: "worker-incoming",
      type: "section_saved",
      summary: "doc=a.md",
      docPath: "a.md",
      payload: { type: "section_saved", doc_path: "a.md" },
    });
    const port = makePort();
    d.subscribe(port);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    const [msg] = port.postMessage.mock.calls[0];
    expect((msg as { type: string }).type).toBe("diagnostics_backlog");
    const entries = (msg as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(2);
    expect((entries[1] as { source: string }).source).toBe("worker-incoming");
    expect((entries[1] as { docPath: string }).docPath).toBe("a.md");
  });

  it("forwards each subsequent capture to all subscribers as diagnostics_event", () => {
    const d = new WorkerDiagnostics();
    const p1 = makePort();
    const p2 = makePort();
    d.subscribe(p1);
    d.subscribe(p2);
    p1.postMessage.mockClear();
    p2.postMessage.mockClear();

    d.capture({
      source: "worker-outgoing",
      type: "subscribe",
      summary: "doc=x.md",
      docPath: "x.md",
      payload: { subscribe: "x.md" },
    });

    expect(p1.postMessage).toHaveBeenCalledTimes(1);
    expect(p2.postMessage).toHaveBeenCalledTimes(1);
    const msg = p1.postMessage.mock.calls[0][0] as {
      type: string;
      entry: { source: string; type: string; docPath?: string };
    };
    expect(msg.type).toBe("diagnostics_event");
    expect(msg.entry.source).toBe("worker-outgoing");
    expect(msg.entry.type).toBe("subscribe");
    expect(msg.entry.docPath).toBe("x.md");
  });

  it("stops forwarding to an unsubscribed port", () => {
    const d = new WorkerDiagnostics();
    const port = makePort();
    d.subscribe(port);
    port.postMessage.mockClear();
    d.unsubscribe(port);
    expect(d.subscriberCount).toBe(0);

    d.capture({ source: "worker-incoming", type: "x", summary: "" });
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("caps the backlog ring at 50 (oldest dropped)", () => {
    const d = new WorkerDiagnostics();
    for (let i = 0; i < 75; i++) {
      d.capture({ source: "worker-incoming", type: `t${i}`, summary: "" });
    }
    expect(d.backlogSize).toBe(50);
    const port = makePort();
    d.subscribe(port);
    const msg = port.postMessage.mock.calls[0][0] as { entries: Array<{ type: string }> };
    expect(msg.entries).toHaveLength(50);
    expect(msg.entries[0].type).toBe("t25");
    expect(msg.entries[49].type).toBe("t74");
  });

  it("does not double-subscribe the same port", () => {
    const d = new WorkerDiagnostics();
    const port = makePort();
    d.subscribe(port);
    d.subscribe(port);
    expect(d.subscriberCount).toBe(1);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
  });

  it("still appends to backlog even when no subscribers, so next subscriber sees history", () => {
    const d = new WorkerDiagnostics();
    for (let i = 0; i < 5; i++) {
      d.capture({ source: "worker-incoming", type: `t${i}`, summary: "" });
    }
    const port = makePort();
    d.subscribe(port);
    const msg = port.postMessage.mock.calls[0][0] as { entries: unknown[] };
    expect(msg.entries).toHaveLength(5);
  });
});
