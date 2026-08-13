import { lookupDocSession } from "../../../crdt/ydoc-lifecycle.js";
import { resolveLiveSectionLayout } from "../../../crdt/live-section-layout.js";
import { isBodyHolderShape } from "../../../storage/section-shape.js";
import type { HeadingLevel } from "../../../types/shared.js";
import type { DocumentDiagnosticsContext } from "../context.js";

export async function runLiveDuplicateSiblingHeadingsCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  const session = lookupDocSession(ctx.docPath);
  if (!session) return;
  try {
    const layout = await resolveLiveSectionLayout(ctx.docPath, session.generator.getCurrentProposalId());
    interface Row { fragmentKey: string; heading: string; headingLevel: HeadingLevel; headingPath: string[]; isBodyHolder: boolean }
    const groups = new Map<string, Row[]>();
    for (const entry of layout) {
      const isBodyHolder = isBodyHolderShape(entry);
      const parentPath = isBodyHolder ? [...entry.headingPath] : entry.headingPath.slice(0, -1);
      const groupKey = `${parentPath.join(">>")}||${entry.heading}@${entry.headingLevel}@${isBodyHolder ? "bh" : "h"}`;
      const row: Row = {
        fragmentKey: entry.fragmentKey,
        heading: entry.heading,
        headingLevel: entry.headingLevel,
        headingPath: [...entry.headingPath],
        isBodyHolder,
      };
      const list = groups.get(groupKey);
      if (list) list.push(row);
      else groups.set(groupKey, [row]);
    }
    const details: string[] = [];
    for (const [, rows] of groups) {
      if (rows.length < 2) continue;
      const first = rows[0];
      const parentPath = first.isBodyHolder ? first.headingPath : first.headingPath.slice(0, -1);
      const parentLabel = parentPath.length > 0 ? parentPath.join(" > ") : "(document root)";
      let identityLabel: string;
      if (first.isBodyHolder) {
        identityLabel = parentPath.length === 0
          ? "duplicate document-level before-first-heading root"
          : `duplicate body-holder for "${parentPath[parentPath.length - 1]}"`;
      } else {
        identityLabel = `duplicate sibling heading "${first.heading}" (heading level ${first.headingLevel})`;
      }
      details.push(`Under ${parentLabel}: ${identityLabel} — ${rows.map((r) => r.fragmentKey).join(", ")}`);
    }
    ctx.pushCheck(
      "Live",
      "live-duplicate-sibling-headings",
      details.length === 0,
      details.length > 0 ? details.join(" | ") : undefined,
    );
  } catch (err) {
    ctx.pushCheck("Live", "live-duplicate-sibling-headings", false, err instanceof Error ? err.message : String(err));
  }
}
