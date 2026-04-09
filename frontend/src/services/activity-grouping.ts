import type { ActivityItem } from "../types/shared.js";

/**
 * Returns a map of doc_path → ISO timestamp of the most recent edit by `currentWriterId`
 * (writer_type === "human"). Used to determine when an agent's activity occurred after
 * the user's most recent edit on a given doc.
 */
export function lastEditTimeByDoc(items: ActivityItem[], currentWriterId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    if (item.writer_id !== currentWriterId || item.writer_type !== "human") continue;
    for (const section of item.sections) {
      const prior = out.get(section.doc_path);
      if (!prior || Date.parse(item.timestamp) > Date.parse(prior)) {
        out.set(section.doc_path, item.timestamp);
      }
    }
  }
  return out;
}

/**
 * Returns agent items whose timestamp is strictly after the user's most recent edit
 * on at least one of the item's section doc_paths. An item with multiple sections
 * qualifies if any one of its doc_paths has a prior user edit older than the item.
 */
export function agentItemsAfterUserEdit(
  items: ActivityItem[],
  lastEditByDoc: Map<string, string>,
): ActivityItem[] {
  return items.filter((item) => {
    if (item.writer_type !== "agent") return false;
    for (const section of item.sections) {
      const lastEdit = lastEditByDoc.get(section.doc_path);
      if (lastEdit && Date.parse(item.timestamp) > Date.parse(lastEdit)) return true;
    }
    return false;
  });
}

/**
 * Returns a new array sorted by timestamp newest-first. Does not mutate the input.
 */
export function sortActivityNewestFirst(items: ActivityItem[]): ActivityItem[] {
  return [...items].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}
