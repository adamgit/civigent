import path from "node:path";
import { readFile } from "node:fs/promises";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { ContentLayer, OverlayContentLayer } from "../../storage/content-layer.js";
import { RawFragmentRecoveryBuffer } from "../../storage/raw-fragment-recovery-buffer.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { FlatEntry } from "../../storage/document-skeleton.js";
import type { DocumentDiagnosticsContext } from "./context.js";
import type { DiagLayerStatus } from "./types.js";

/**
 * Precedence order (lowest → highest freshness). Each later layer shadows the
 * earlier ones when present. Fragment must participate: if the CRDT session is
 * gone but a raw fragment survives, the fragment is what recovery will read.
 *
 *   canonical → overlay → fragment → crdt
 *
 * Exported for focused testing of the precedence logic in isolation from the
 * filesystem / skeleton context.
 */
export function computeLayerWinner(layers: {
  canonical: Pick<DiagLayerStatus, "exists">;
  overlay: Pick<DiagLayerStatus, "exists">;
  fragment: Pick<DiagLayerStatus, "exists">;
  crdt: Pick<DiagLayerStatus, "exists">;
}): "none" | "canonical" | "overlay" | "fragment" | "crdt" {
  if (layers.crdt.exists) return "crdt";
  if (layers.fragment.exists) return "fragment";
  if (layers.overlay.exists) return "overlay";
  if (layers.canonical.exists) return "canonical";
  return "none";
}

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

function absentLayer(): DiagLayerStatus {
  return { exists: false, byteLength: null, contentPreview: null, error: null };
}

function entryIsBfh(entry: FlatEntry): boolean {
  return entry.level === 0 && entry.heading === "";
}

function fragmentKeyForEntry(entry: FlatEntry): string {
  return fragmentKeyFromSectionFile(entry.sectionFile, entryIsBfh(entry));
}

interface UnionRow {
  fragmentKey: string;
  canonicalEntry: FlatEntry | null;
  overlayEntry: FlatEntry | null;
  fragmentFileName: string | null;
  hasCrdt: boolean;
}

function pushOverlayVsCanonicalDivergenceCheck(
  ctx: DocumentDiagnosticsContext,
  canonicalEntries: FlatEntry[],
  overlayEntries: FlatEntry[] | null,
): void {
  const canonicalKeys = new Set(canonicalEntries.map((e) => SectionRef.headingKey(e.headingPath)));
  const effectiveOverlay = overlayEntries ?? canonicalEntries;
  const overlayKeys = new Set(effectiveOverlay.map((e) => SectionRef.headingKey(e.headingPath)));
  const onlyInCanonical = [...canonicalKeys].filter((k) => !overlayKeys.has(k));
  const onlyInOverlay = [...overlayKeys].filter((k) => !canonicalKeys.has(k));
  const symmetricDifference = [...onlyInCanonical, ...onlyInOverlay].sort();
  if (symmetricDifference.length === 0) {
    ctx.pushCheck("Structure Consistency", "overlay-vs-canonical structure divergence", true);
    return;
  }
  const detail = [
    onlyInCanonical.length > 0
      ? `only in canonical: ${onlyInCanonical.map((k) => `"${k}"`).join(", ")}`
      : null,
    onlyInOverlay.length > 0
      ? `only in overlay: ${onlyInOverlay.map((k) => `"${k}"`).join(", ")}`
      : null,
  ]
    .filter((s): s is string => s !== null)
    .join("; ");
  ctx.pushCheck(
    "Structure Consistency",
    "overlay-vs-canonical structure divergence",
    false,
    detail,
  );
}

export async function collectSectionLayers(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const canonicalLayer = new ContentLayer(ctx.contentRoot);
    const overlayLayer = new OverlayContentLayer(ctx.overlayContentRoot, ctx.contentRoot);
    const recoveryBuffer = new RawFragmentRecoveryBuffer(ctx.docPath);

    const canonicalEntries = await canonicalLayer.listCanonicalEntries(ctx.docPath);
    const overlayEntries = await overlayLayer.listOverlayOnlyEntries(ctx.docPath);
    const persistedFragments = await recoveryBuffer.listPersistedFragments();

    const session = lookupDocSession(ctx.docPath);
    const crdtKeys = session ? session.liveFragments.getFragmentKeys() : [];

    pushOverlayVsCanonicalDivergenceCheck(ctx, canonicalEntries, overlayEntries);

    const rowOrder: string[] = [];
    const rowsByKey = new Map<string, UnionRow>();
    const ensureRow = (fragmentKey: string): UnionRow => {
      let row = rowsByKey.get(fragmentKey);
      if (!row) {
        row = {
          fragmentKey,
          canonicalEntry: null,
          overlayEntry: null,
          fragmentFileName: null,
          hasCrdt: false,
        };
        rowsByKey.set(fragmentKey, row);
        rowOrder.push(fragmentKey);
      }
      return row;
    };

    for (const entry of canonicalEntries) {
      ensureRow(fragmentKeyForEntry(entry)).canonicalEntry = entry;
    }
    if (overlayEntries) {
      for (const entry of overlayEntries) {
        ensureRow(fragmentKeyForEntry(entry)).overlayEntry = entry;
      }
    }
    for (const frag of persistedFragments) {
      ensureRow(frag.fragmentKey).fragmentFileName = frag.fileName;
    }
    for (const key of crdtKeys) {
      ensureRow(key).hasCrdt = true;
    }

    for (const fragmentKey of rowOrder) {
      const row = rowsByKey.get(fragmentKey)!;
      try {
        let headingPath: string[];
        let sectionFile: string;
        let isSubSkeleton: boolean;
        let headingKey: string;
        if (row.overlayEntry) {
          headingPath = [...row.overlayEntry.headingPath];
          sectionFile = row.overlayEntry.sectionFile;
          isSubSkeleton = row.overlayEntry.isSubSkeleton;
          headingKey = SectionRef.headingKey(headingPath);
        } else if (row.canonicalEntry) {
          headingPath = [...row.canonicalEntry.headingPath];
          sectionFile = row.canonicalEntry.sectionFile;
          isSubSkeleton = row.canonicalEntry.isSubSkeleton;
          headingKey = SectionRef.headingKey(headingPath);
        } else {
          headingPath = [];
          sectionFile = row.fragmentFileName ?? "";
          isSubSkeleton = false;
          headingKey = "__fragment_only__::" + fragmentKey;
        }

        const canonical = row.canonicalEntry
          ? await readLayer(row.canonicalEntry.absolutePath)
          : absentLayer();
        const overlay = row.overlayEntry
          ? await readLayer(row.overlayEntry.absolutePath)
          : absentLayer();
        const fragment = row.fragmentFileName
          ? await readLayer(path.join(ctx.fragmentDir, row.fragmentFileName))
          : absentLayer();

        let crdt: DiagLayerStatus = absentLayer();
        if (row.hasCrdt && session) {
          try {
            const md = session.liveFragments.readFragmentString(fragmentKey);
            if (md != null) {
              const mdStr = md as unknown as string;
              crdt = {
                exists: true,
                byteLength: Buffer.byteLength(mdStr, "utf8"),
                contentPreview: mdStr.slice(0, 200),
                error: null,
              };
            }
          } catch (err) {
            crdt = {
              exists: false,
              byteLength: null,
              contentPreview: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        const winner = computeLayerWinner({ canonical, overlay, fragment, crdt });

        ctx.sections.push({
          headingKey,
          headingPath,
          sectionFile,
          isSubSkeleton,
          canonical,
          overlay,
          fragment,
          crdt,
          winner,
        });
      } catch (err) {
        ctx.sections.push({
          headingKey: "__fragment_only__::" + fragmentKey,
          headingPath: [],
          sectionFile: row.fragmentFileName ?? "",
          isSubSkeleton: false,
          canonical: absentLayer(),
          overlay: absentLayer(),
          fragment: absentLayer(),
          crdt: absentLayer(),
          winner: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    ctx.pushCheck(
      "Recursive Structure Checks",
      "section-layer-collection",
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}
