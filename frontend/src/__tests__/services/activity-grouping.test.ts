import { describe, it, expect } from "vitest";
import {
  lastEditTimeByDoc,
  agentItemsAfterUserEdit,
  sortActivityNewestFirst,
} from "../../services/activity-grouping";
import type { ActivityItem } from "../../types/shared.js";

function makeItem(partial: Partial<ActivityItem> & { id: string; timestamp: string; sections: ActivityItem["sections"] }): ActivityItem {
  return {
    writer_id: "user-1",
    writer_type: "human",
    writer_display_name: "User One",
    commit_sha: "abc123",
    ...partial,
  } as ActivityItem;
}

describe("lastEditTimeByDoc", () => {
  it("returns empty map for empty items", () => {
    expect(lastEditTimeByDoc([], "user-1").size).toBe(0);
  });

  it("picks latest timestamp when same doc is edited multiple times", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
      makeItem({
        id: "2",
        timestamp: "2026-01-03T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
      makeItem({
        id: "3",
        timestamp: "2026-01-02T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
    ];
    const result = lastEditTimeByDoc(items, "user-1");
    expect(result.get("a.md")).toBe("2026-01-03T00:00:00.000Z");
  });

  it("tracks multiple docs independently", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
      makeItem({
        id: "2",
        timestamp: "2026-01-02T00:00:00.000Z",
        sections: [{ doc_path: "b.md", heading_path: ["H"] }],
      }),
    ];
    const result = lastEditTimeByDoc(items, "user-1");
    expect(result.size).toBe(2);
    expect(result.get("a.md")).toBe("2026-01-01T00:00:00.000Z");
    expect(result.get("b.md")).toBe("2026-01-02T00:00:00.000Z");
  });

  it("ignores agent items", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        writer_type: "agent",
        timestamp: "2026-01-01T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
    ];
    expect(lastEditTimeByDoc(items, "user-1").size).toBe(0);
  });

  it("ignores items by other writer_ids", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        writer_id: "user-2",
        timestamp: "2026-01-01T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
    ];
    expect(lastEditTimeByDoc(items, "user-1").size).toBe(0);
  });

  it("item with multiple sections records timestamp for each doc_path", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sections: [
          { doc_path: "a.md", heading_path: ["H"] },
          { doc_path: "b.md", heading_path: ["I"] },
        ],
      }),
    ];
    const result = lastEditTimeByDoc(items, "user-1");
    expect(result.get("a.md")).toBe("2026-01-01T00:00:00.000Z");
    expect(result.get("b.md")).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("agentItemsAfterUserEdit", () => {
  it("returns empty for empty inputs", () => {
    expect(agentItemsAfterUserEdit([], new Map())).toEqual([]);
  });

  it("excludes agent edits with no user history on the doc", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        writer_type: "agent",
        timestamp: "2026-01-05T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
    ];
    expect(agentItemsAfterUserEdit(items, new Map())).toEqual([]);
  });

  it("excludes agent edits before user's last edit on the doc", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        writer_type: "agent",
        timestamp: "2026-01-01T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
    ];
    const lastEdit = new Map([["a.md", "2026-01-05T00:00:00.000Z"]]);
    expect(agentItemsAfterUserEdit(items, lastEdit)).toEqual([]);
  });

  it("includes agent edits strictly after user's last edit on the doc", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        writer_type: "agent",
        timestamp: "2026-01-10T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
    ];
    const lastEdit = new Map([["a.md", "2026-01-05T00:00:00.000Z"]]);
    const result = agentItemsAfterUserEdit(items, lastEdit);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("includes agent items where ANY section qualifies", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        writer_type: "agent",
        timestamp: "2026-01-10T00:00:00.000Z",
        sections: [
          { doc_path: "no-history.md", heading_path: ["H"] },
          { doc_path: "a.md", heading_path: ["I"] },
        ],
      }),
    ];
    const lastEdit = new Map([["a.md", "2026-01-05T00:00:00.000Z"]]);
    const result = agentItemsAfterUserEdit(items, lastEdit);
    expect(result).toHaveLength(1);
  });

  it("excludes human items even if doc has user history", () => {
    const items: ActivityItem[] = [
      makeItem({
        id: "1",
        writer_type: "human",
        timestamp: "2026-01-10T00:00:00.000Z",
        sections: [{ doc_path: "a.md", heading_path: ["H"] }],
      }),
    ];
    const lastEdit = new Map([["a.md", "2026-01-05T00:00:00.000Z"]]);
    expect(agentItemsAfterUserEdit(items, lastEdit)).toEqual([]);
  });
});

describe("sortActivityNewestFirst", () => {
  it("returns empty for empty input", () => {
    expect(sortActivityNewestFirst([])).toEqual([]);
  });

  it("returns single item unchanged", () => {
    const items: ActivityItem[] = [
      makeItem({ id: "1", timestamp: "2026-01-01T00:00:00.000Z", sections: [] }),
    ];
    expect(sortActivityNewestFirst(items)).toEqual(items);
  });

  it("sorts already-sorted input correctly", () => {
    const items: ActivityItem[] = [
      makeItem({ id: "1", timestamp: "2026-01-03T00:00:00.000Z", sections: [] }),
      makeItem({ id: "2", timestamp: "2026-01-02T00:00:00.000Z", sections: [] }),
      makeItem({ id: "3", timestamp: "2026-01-01T00:00:00.000Z", sections: [] }),
    ];
    const sorted = sortActivityNewestFirst(items);
    expect(sorted.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  it("reverses ascending input", () => {
    const items: ActivityItem[] = [
      makeItem({ id: "1", timestamp: "2026-01-01T00:00:00.000Z", sections: [] }),
      makeItem({ id: "2", timestamp: "2026-01-02T00:00:00.000Z", sections: [] }),
      makeItem({ id: "3", timestamp: "2026-01-03T00:00:00.000Z", sections: [] }),
    ];
    const sorted = sortActivityNewestFirst(items);
    expect(sorted.map((i) => i.id)).toEqual(["3", "2", "1"]);
  });

  it("preserves stable order for equal timestamps", () => {
    const items: ActivityItem[] = [
      makeItem({ id: "a", timestamp: "2026-01-01T00:00:00.000Z", sections: [] }),
      makeItem({ id: "b", timestamp: "2026-01-01T00:00:00.000Z", sections: [] }),
      makeItem({ id: "c", timestamp: "2026-01-01T00:00:00.000Z", sections: [] }),
    ];
    const sorted = sortActivityNewestFirst(items);
    expect(sorted.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const items: ActivityItem[] = [
      makeItem({ id: "1", timestamp: "2026-01-01T00:00:00.000Z", sections: [] }),
      makeItem({ id: "2", timestamp: "2026-01-02T00:00:00.000Z", sections: [] }),
    ];
    const before = items.map((i) => i.id);
    sortActivityNewestFirst(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });
});
