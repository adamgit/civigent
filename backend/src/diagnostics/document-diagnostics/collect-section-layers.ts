import { readFile } from "node:fs/promises";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { resolveLiveSectionLayout, type LiveSectionLayoutEntry } from "../../crdt/live-section-layout.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { FlatEntry } from "../../storage/document-skeleton.js";
import { isBodyHolderShape } from "../../storage/section-shape.js";
import { findInProgressProposalForDoc } from "../../storage/proposal-repository.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { resolveDiagnosticsDraftProposalId, type DocumentDiagnosticsContext } from "./context.js";
import type { DiagLayerStatus } from "./types.js";

/**
 * Precedence order (lowest → highest freshness):
 *
 *   canonical → proposal (inprogress) → crdt (live)
 *
 * The proposal rung is the durable saved state: with no live CRDT session, a
 * refresh reconstructs from the inprogress proposal, not canonical alone. A
 * canonical-only view of diagnostics would hide the difference between the
 * two, so callers see the effective-proposal body directly here. Exported for
 * focused testing of the precedence logic in isolation from the filesystem /
 * skeleton context.
 */
export function computeLayerWinner(layers: {
  canonical: Pick<DiagLayerStatus, "exists">;
  proposal?: Pick<DiagLayerStatus, "exists">;
  crdt: Pick<DiagLayerStatus, "exists">;
}): "none" | "canonical" | "proposal" | "crdt" {
  if (layers.crdt.exists) return "crdt";
  if (layers.proposal && layers.proposal.exists) return "proposal";
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
  return isBodyHolderShape(entry);
}

function fragmentKeyForEntry(entry: FlatEntry): string {
  return fragmentKeyFromSectionFile(entry.sectionFile, entryIsBfh(entry));
}

interface UnionRow {
  fragmentKey: string;
  canonicalEntry: FlatEntry | null;
  hasCrdt: boolean;
}

export async function collectSectionLayers(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const canonicalLayer = new ContentLayer(ctx.contentRoot);
    const canonicalEntries = await canonicalLayer.listCanonicalEntries(ctx.docPath);

    // Effective inprogress proposal — durable saved state (survives refresh via
    // the proposal reader, which merges canonical + inprogress overlay). Read
    // through `ProposalReader.readAllSections` so the same rules every other
    // proposal-bound read applies (identity-based delete overlay).
    let proposalBodies: Map<string, SectionBody> | null = null;
    try {
      const inprogress = await findInProgressProposalForDoc(ctx.docPath);
      if (inprogress) {
        proposalBodies = await ProposalReader.open(inprogress.id, "inprogress").readAllSections(ctx.docPath);
      }
    } catch {
      proposalBodies = null;
    }

    const session = lookupDocSession(ctx.docPath);
    const crdtKeys = session ? session.liveFragments.getFragmentKeys() : [];

    const liveLayoutByFragmentKey = new Map<string, LiveSectionLayoutEntry>();
    const draftProposalId = await resolveDiagnosticsDraftProposalId(ctx.docPath);
    if (draftProposalId) {
      try {
        const liveLayout = await resolveLiveSectionLayout(ctx.docPath, draftProposalId);
        for (const entry of liveLayout) liveLayoutByFragmentKey.set(entry.fragmentKey, entry);
      } catch {
        liveLayoutByFragmentKey.clear();
      }
    }

    const rowOrder: string[] = [];
    const rowsByKey = new Map<string, UnionRow>();
    const ensureRow = (fragmentKey: string): UnionRow => {
      let row = rowsByKey.get(fragmentKey);
      if (!row) {
        row = {
          fragmentKey,
          canonicalEntry: null,
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
    for (const key of crdtKeys) {
      ensureRow(key).hasCrdt = true;
    }
    for (const fragmentKey of liveLayoutByFragmentKey.keys()) {
      ensureRow(fragmentKey);
    }

    for (const fragmentKey of rowOrder) {
      const row = rowsByKey.get(fragmentKey)!;
      const liveEntry = liveLayoutByFragmentKey.get(fragmentKey) ?? null;
      try {
        let headingPath: string[];
        let sectionFile: string;
        let isSubSkeleton: boolean;
        let headingKey: string;
        if (row.canonicalEntry) {
          headingPath = [...row.canonicalEntry.headingPath];
          sectionFile = row.canonicalEntry.sectionFile;
          isSubSkeleton = row.canonicalEntry.isSubSkeleton;
          headingKey = SectionRef.headingKey(headingPath);
        } else if (liveEntry) {
          headingPath = [...liveEntry.headingPath];
          sectionFile = "";
          isSubSkeleton = false;
          headingKey = SectionRef.headingKey(headingPath);
        } else {
          headingPath = [];
          sectionFile = "";
          isSubSkeleton = false;
          headingKey = "__crdt_only__::" + fragmentKey;
        }

        const canonical = row.canonicalEntry
          ? await readLayer(row.canonicalEntry.absolutePath)
          : absentLayer();

        let proposal: DiagLayerStatus = absentLayer();
        if (proposalBodies) {
          const proposalLookupKey = liveEntry
            ? SectionRef.headingKey(liveEntry.headingPath)
            : headingKey;
          const body = proposalBodies.get(proposalLookupKey) ?? proposalBodies.get(headingKey);
          if (body !== undefined) {
            proposal = {
              exists: true,
              byteLength: Buffer.byteLength(body, "utf8"),
              contentPreview: body.slice(0, 200),
              error: null,
            };
          }
        }

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

        const winner = computeLayerWinner({ canonical, proposal, crdt });

        ctx.sections.push({
          fragmentKey,
          headingKey,
          headingPath,
          liveHeadingPath: liveEntry ? [...liveEntry.headingPath] : null,
          liveHeadingKey: liveEntry ? SectionRef.headingKey(liveEntry.headingPath) : null,
          sectionFile,
          isSubSkeleton,
          canonical,
          proposal,
          crdt,
          winner,
        });
      } catch (err) {
        ctx.sections.push({
          fragmentKey,
          headingKey: "__crdt_only__::" + fragmentKey,
          headingPath: [],
          liveHeadingPath: null,
          liveHeadingKey: null,
          sectionFile: "",
          isSubSkeleton: false,
          canonical: absentLayer(),
          proposal: absentLayer(),
          crdt: absentLayer(),
          winner: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    ctx.pushCheck(
      "Canonical",
      "section-layer-collection",
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}
