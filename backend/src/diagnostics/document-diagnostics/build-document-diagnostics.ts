import type { DocDiagnosticsResponse } from "./types.js";
import { createDocumentDiagnosticsContext } from "./context.js";
import { collectSectionLayers } from "./collect-section-layers.js";
import { runTopLevelSkeletonParseCheck } from "./checks/top-level-skeleton-parse.js";
import { runTopLevelNoUnreferencedFilesCheck } from "./checks/top-level-no-unreferenced-files.js";
import { runTopLevelNoStaleSectionsDirsCheck } from "./checks/top-level-no-stale-sections-dirs.js";
import { runTopLevelAllSectionsReadableCheck } from "./checks/top-level-all-sections-readable.js";
import { runTopLevelAllSectionsParseableCheck } from "./checks/top-level-all-sections-parseable.js";
import { runLiveCrdtSessionCheck } from "./checks/live-crdt-session.js";
import { runRecursiveStructureLoadCheck } from "./checks/recursive-structure-load.js";
import { runRecursiveNoUnreferencedFilesCheck } from "./checks/recursive-no-unreferenced-files.js";
import { runRecursiveAllSectionsReadableCheck } from "./checks/recursive-all-sections-readable.js";
import { runRecursiveNoStaleSubskeletonFilesCheck } from "./checks/recursive-no-stale-subskeleton-files.js";
import { runDuplicateSectionFilesInRecursiveSkeletonCheck } from "./checks/duplicate-section-files-in-recursive-skeleton.js";
import { runDuplicateFragmentKeysCheck } from "./checks/duplicate-fragment-keys.js";
import { runRestoreTargetRecursiveMatchCheck } from "./checks/restore-target-recursive-match.js";
import { runRestoreFeasibleCheck } from "./checks/restore-feasible.js";

export async function buildDocumentDiagnostics(docPath: string): Promise<DocDiagnosticsResponse> {
  const ctx = createDocumentDiagnosticsContext(docPath);

  await runTopLevelSkeletonParseCheck(ctx);
  await runTopLevelNoUnreferencedFilesCheck(ctx);
  await runTopLevelNoStaleSectionsDirsCheck(ctx);
  await runTopLevelAllSectionsReadableCheck(ctx);
  await runTopLevelAllSectionsParseableCheck(ctx);

  // Live CRDT session presence is still a meaningful diagnostic; session-overlay
  // disk checks (exists / orphaned / read-path / overlay-vs-canonical match) are
  // removed — `sessions/` is no longer a durable surface (Area D/spec 05).
  await runLiveCrdtSessionCheck(ctx);

  await runRecursiveStructureLoadCheck(ctx);
  await runRecursiveNoUnreferencedFilesCheck(ctx);
  await runRecursiveAllSectionsReadableCheck(ctx);
  await runRecursiveNoStaleSubskeletonFilesCheck(ctx);
  await runDuplicateSectionFilesInRecursiveSkeletonCheck(ctx);
  await runDuplicateFragmentKeysCheck(ctx);

  await runRestoreTargetRecursiveMatchCheck(ctx);
  await collectSectionLayers(ctx);
  await runRestoreFeasibleCheck(ctx);

  return {
    doc_path: ctx.docPath,
    checks: ctx.checks,
    sections: ctx.sections,
    summary: ctx.summary,
    restore_provenance: ctx.restoreProvenance,
  };
}
