import path from "node:path";
import { readFile } from "node:fs/promises";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import type { DocumentDiagnosticsContext } from "./context.js";
import type { DiagLayerStatus } from "./types.js";
import { ensureRecursiveSkeleton } from "./context.js";

async function readLayer(filePath: string): Promise<DiagLayerStatus> {
  try {
    const content = await readFile(filePath, "utf8");
    return {
      exists: true,
      byteLength: Buffer.byteLength(content, "utf8"),
      contentPreview: content.slice(0, 200),
      error: null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, byteLength: null, contentPreview: null, error: null };
    }
    return { exists: false, byteLength: null, contentPreview: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function collectSectionLayers(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const skeleton = await ensureRecursiveSkeleton(ctx);
    const sectionEntries: Array<{
      heading: string;
      level: number;
      sectionFile: string;
      headingPath: string[];
      absolutePath: string;
      isSubSkeleton: boolean;
    }> = [];
    skeleton.forEachNode((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
      sectionEntries.push({ heading, level, sectionFile, headingPath: [...headingPath], absolutePath, isSubSkeleton });
    });

    const session = lookupDocSession(ctx.docPath);

    for (const entry of sectionEntries) {
      try {
        const headingKey = entry.headingPath.join(">>");
        const isBfh = entry.level === 0 && entry.heading === "";
        const fragKey = fragmentKeyFromSectionFile(entry.sectionFile, isBfh);
        const canonical = await readLayer(entry.absolutePath);
        const overlay = await readLayer(path.join(ctx.overlayContentRoot, path.relative(ctx.contentRoot, entry.absolutePath)));
        const fragment = await readLayer(path.join(ctx.fragmentDir, entry.sectionFile));

        let crdt: DiagLayerStatus = { exists: false, byteLength: null, contentPreview: null, error: null };
        if (session) {
          try {
            const md = session.liveFragments.readFragmentString(fragKey) || null;
            if (md != null) {
              crdt = {
                exists: true,
                byteLength: Buffer.byteLength(md, "utf8"),
                contentPreview: md.slice(0, 200),
                error: null,
              };
            }
          } catch (err) {
            crdt = { exists: false, byteLength: null, contentPreview: null, error: err instanceof Error ? err.message : String(err) };
          }
        }

        let winner = "none";
        if (canonical.exists) winner = "canonical";
        if (overlay.exists) winner = "overlay";
        if (crdt.exists) winner = "crdt";

        ctx.sections.push({
          headingKey,
          headingPath: entry.headingPath,
          sectionFile: entry.sectionFile,
          isSubSkeleton: entry.isSubSkeleton,
          canonical,
          overlay,
          fragment,
          crdt,
          winner,
        });
      } catch (err) {
        ctx.sections.push({
          headingKey: entry.headingPath.join(">>"),
          headingPath: entry.headingPath,
          sectionFile: entry.sectionFile,
          isSubSkeleton: entry.isSubSkeleton,
          canonical: { exists: false, byteLength: null, contentPreview: null, error: null },
          overlay: { exists: false, byteLength: null, contentPreview: null, error: null },
          fragment: { exists: false, byteLength: null, contentPreview: null, error: null },
          crdt: { exists: false, byteLength: null, contentPreview: null, error: null },
          winner: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    ctx.pushCheck("Recursive Structure Checks", "section-layer-collection", false, err instanceof Error ? err.message : String(err));
  }
}
