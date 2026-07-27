import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WsServerEvent } from "../../types/shared.js";
import {
  emitProposalDraftEventsByDoc,
  emitProposalInProgressEventsByDoc,
  emitProposalWithdrawnEventsByDoc,
  emitContentCommittedEventsByDoc,
} from "../../api/application/events.js";

const EVENTS_FILE = path.join(__dirname, "..", "..", "api", "application", "events.ts");

const writer = { id: "w1", type: "human" as const, displayName: "Writer One" };

describe("application/events.ts construction", () => {
  it("does not construct proposal:injected_into_session", async () => {
    const source = await readFile(EVENTS_FILE, "utf8");
    expect(source).not.toMatch(/proposal:injected_into_session/);
    expect(source).not.toMatch(/emitProposalInjectedEvents/);
  });

  it("groups proposal:draft events by doc with expected shape", () => {
    const events: WsServerEvent[] = [];
    emitProposalDraftEventsByDoc(
      (e) => events.push(e),
      "p1",
      writer,
      "intent text",
      [
        { kind: "section", doc_path: "/a.md", heading_path: ["X"] },
        { kind: "section", doc_path: "/a.md", heading_path: ["Y"] },
        { kind: "section", doc_path: "/b.md", heading_path: ["Z"] },
        { kind: "document", doc_path: "/c.md" },
      ],
    );
    expect(events).toHaveLength(3);
    const a = events.find((e) => (e as { doc_path: string }).doc_path === "/a.md") as Extract<WsServerEvent, { type: "proposal:draft" }>;
    expect(a.type).toBe("proposal:draft");
    expect(a.proposal_id).toBe("p1");
    expect(a.heading_paths).toEqual([["X"], ["Y"]]);
    expect(a.writer_id).toBe("w1");
    expect(a.intent).toBe("intent text");
    // A document-only target still yields an event for its doc, with no heading paths.
    const c = events.find((e) => (e as { doc_path: string }).doc_path === "/c.md") as Extract<WsServerEvent, { type: "proposal:draft" }>;
    expect(c.heading_paths).toEqual([]);
  });

  it("constructs proposal:inprogress events", () => {
    const events: WsServerEvent[] = [];
    emitProposalInProgressEventsByDoc((e) => events.push(e), "p2", writer, "i", [
      { kind: "section", doc_path: "/a.md", heading_path: ["X"] },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("proposal:inprogress");
  });

  it("constructs proposal:withdrawn events", () => {
    const events: WsServerEvent[] = [];
    emitProposalWithdrawnEventsByDoc((e) => events.push(e), "p3", [
      { kind: "section", doc_path: "/a.md", heading_path: ["X"] },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("proposal:withdrawn");
    expect((events[0] as { proposal_id: string }).proposal_id).toBe("p3");
  });

  it("constructs content:committed events", () => {
    const events: WsServerEvent[] = [];
    emitContentCommittedEventsByDoc(
      (e) => events.push(e),
      writer,
      ["w1"],
      "abc123",
      [{ kind: "section", doc_path: "/a.md", heading_path: ["X"] }],
    );
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<WsServerEvent, { type: "content:committed" }>;
    expect(e.type).toBe("content:committed");
    expect(e.commit_sha).toBe("abc123");
    expect(e.contributor_ids).toEqual(["w1"]);
    expect(e.sections).toEqual([{ doc_path: "/a.md", heading_path: ["X"] }]);
  });

  it("emits nothing when targets are empty or emit callback is undefined", () => {
    const events: WsServerEvent[] = [];
    emitProposalDraftEventsByDoc((e) => events.push(e), "p", writer, "i", []);
    expect(events).toHaveLength(0);
    expect(() => emitProposalDraftEventsByDoc(undefined, "p", writer, "i", [
      { kind: "section", doc_path: "/a.md", heading_path: ["X"] },
    ])).not.toThrow();
  });
});
