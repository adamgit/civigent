import { describe, it, expect } from "vitest";
import { classifyWsEvent } from "../../app/app-layout-utils";

describe("classifyWsEvent", () => {
  it("ignores dirty:changed events", () => {
    const result = classifyWsEvent({ type: "dirty:changed" }, "/doc.md", true);
    expect(result.refreshTree).toBe(false);
    expect(result.addBadge).toBeNull();
    expect(result.showToast).toBeNull();
  });

  it("catalog:changed triggers refreshTree and passes flash data", () => {
    const result = classifyWsEvent(
      { type: "catalog:changed", added_doc_paths: ["/new.md"], writer_type: "agent" },
      "/doc.md",
      true,
    );
    expect(result.refreshTree).toBe(true);
    expect(result.addBadge).toBeNull();
    expect(result.showToast).toBeNull();
    expect(result.flashDocPaths).toEqual(["/new.md"]);
    expect(result.flashWriterType).toBe("agent");
  });

  it("doc:renamed triggers refreshTree only", () => {
    const result = classifyWsEvent({ type: "doc:renamed" }, "/doc.md", true);
    expect(result.refreshTree).toBe(true);
    expect(result.addBadge).toBeNull();
    expect(result.showToast).toBeNull();
  });

  it("content:committed by human triggers refresh only", () => {
    const result = classifyWsEvent(
      { type: "content:committed", doc_path: "doc.md", writer_type: "human", writer_display_name: "Alice" },
      "/other.md",
      true,
    );
    expect(result.refreshTree).toBe(true);
    expect(result.addBadge).toBeNull();
    expect(result.showToast).toBeNull();
  });

  it("agent commit on same doc while tab active: no badge, no toast", () => {
    const result = classifyWsEvent(
      { type: "content:committed", doc_path: "doc.md", writer_type: "agent", writer_display_name: "Bot" },
      "/doc.md",
      true,
    );
    expect(result.refreshTree).toBe(true);
    expect(result.addBadge).toBeNull();
    expect(result.showToast).toBeNull();
  });

  it("agent commit on different doc while tab active: badge + toast", () => {
    const result = classifyWsEvent(
      { type: "content:committed", doc_path: "other.md", writer_type: "agent", writer_display_name: "Bot" },
      "/doc.md",
      true,
    );
    expect(result.refreshTree).toBe(true);
    expect(result.addBadge).toBe("/other.md");
    expect(result.showToast).toEqual({
      text: "Bot updated /other.md",
      docPath: "/other.md",
    });
  });

  it("agent commit while tab inactive: badge, no toast", () => {
    const result = classifyWsEvent(
      { type: "content:committed", doc_path: "other.md", writer_type: "agent", writer_display_name: "Bot" },
      "/doc.md",
      false,
    );
    expect(result.refreshTree).toBe(true);
    expect(result.addBadge).toBe("/other.md");
    expect(result.showToast).toBeNull();
  });

  it("unknown event type is a no-op", () => {
    const result = classifyWsEvent({ type: "some:unknown:event" }, "/doc.md", true);
    expect(result.refreshTree).toBe(false);
    expect(result.addBadge).toBeNull();
    expect(result.showToast).toBeNull();
  });

  // The JSON app WS forwards every server event opaquely (no whitelist in
  // ws-client / ws-shared-worker). At the AppLayout classification layer,
  // section-availability events are pass-through no-ops (they are doc-page
  // concerns, not tree/badge/toast triggers) — they must never throw or be
  // dropped in a way that breaks delivery to other consumers.
  it.each(["section:blocked", "section:unblocked", "section:gone", "content:committed"] as const)(
    "%s is classified without throwing and is not mishandled at the layout layer",
    (type) => {
      expect(() => classifyWsEvent({ type }, "/doc.md", true)).not.toThrow();
    },
  );

  it("section:* events are layout-level no-ops (not tree/badge/toast triggers)", () => {
    for (const type of ["section:blocked", "section:unblocked", "section:gone"]) {
      const result = classifyWsEvent({ type, doc_path: "doc.md" }, "/doc.md", true);
      expect(result.refreshTree).toBe(false);
      expect(result.addBadge).toBeNull();
      expect(result.showToast).toBeNull();
    }
  });

  it("removed dirty-persistence triggers are no-ops at the layout layer", () => {
    for (const type of ["writer:dirty-state-changed", "session:status-changed"]) {
      const result = classifyWsEvent({ type, doc_path: "doc.md" }, "/doc.md", true);
      expect(result.refreshTree).toBe(false);
      expect(result.addBadge).toBeNull();
      expect(result.showToast).toBeNull();
    }
  });
});
