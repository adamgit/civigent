import type { DocDiagnosticsResponse } from "./types.js";
import { createDocumentDiagnosticsContext } from "./context.js";
import { collectSectionLayers } from "./collect-section-layers.js";
import { runTopLevelSkeletonParseCheck } from "./checks/top-level-skeleton-parse.js";
import { runTopLevelNoUnreferencedFilesCheck } from "./checks/top-level-no-unreferenced-files.js";
import { runTopLevelNoStaleSectionsDirsCheck } from "./checks/top-level-no-stale-sections-dirs.js";
import { runTopLevelAllSectionsReadableCheck } from "./checks/top-level-all-sections-readable.js";
import { runTopLevelAllSectionsParseableCheck } from "./checks/top-level-all-sections-parseable.js";
import { runLiveCrdtSessionCheck } from "./checks/live-crdt-session.js";
import { runLiveDuplicateHeadingPathsCheck } from "./checks/live-duplicate-heading-paths.js";
import { runLiveDuplicateSiblingHeadingsCheck } from "./checks/live-duplicate-sibling-headings.js";
import { runLiveTopologyVsCanonicalCheck } from "./checks/live-topology-vs-canonical.js";
import { runLiveClaimSetOrphansCheck } from "./checks/live-claim-set-orphans.js";
import { runRecursiveStructureLoadCheck } from "./checks/recursive-structure-load.js";
import { runRecursiveNoUnreferencedFilesCheck } from "./checks/recursive-no-unreferenced-files.js";
import { runRecursiveAllSectionsReadableCheck } from "./checks/recursive-all-sections-readable.js";
import { runRecursiveNoStaleSubskeletonFilesCheck } from "./checks/recursive-no-stale-subskeleton-files.js";
import { runDuplicateSectionFilesInRecursiveSkeletonCheck } from "./checks/duplicate-section-files-in-recursive-skeleton.js";
import { runDuplicateFragmentKeysCheck } from "./checks/duplicate-fragment-keys.js";
import { runDuplicateHeadingPathsCheck } from "./checks/duplicate-heading-paths.js";
import { runDuplicateSiblingHeadingsCheck } from "./checks/duplicate-sibling-headings.js";
import { runLogicalDocumentLossCheck } from "./checks/logical-document-loss.js";
import { runBodyVsSkeletonHeadingsCheck } from "./checks/body-vs-skeleton-headings.js";
import { runCanonicalProseUnicodeEscapesCheck } from "./checks/canonical-prose-unicode-escapes.js";
import { runBackendStateCheck } from "./checks/backend-state.js";
import { runRestoreTargetRecursiveMatchCheck } from "./checks/restore-target-recursive-match.js";
import { runRestoreFeasibleCheck } from "./checks/restore-feasible.js";
import type { DocPath } from "../../types/shared.js";

export async function buildDocumentDiagnostics(docPath: DocPath): Promise<DocDiagnosticsResponse> {
  const ctx = createDocumentDiagnosticsContext(docPath);

  await runTopLevelSkeletonParseCheck(ctx);
  await runTopLevelNoUnreferencedFilesCheck(ctx);
  await runTopLevelNoStaleSectionsDirsCheck(ctx);
  await runTopLevelAllSectionsReadableCheck(ctx);
  await runTopLevelAllSectionsParseableCheck(ctx);

  await runLiveCrdtSessionCheck(ctx);
  await runLiveDuplicateHeadingPathsCheck(ctx);
  await runLiveDuplicateSiblingHeadingsCheck(ctx);
  await runLiveTopologyVsCanonicalCheck(ctx);
  await runLiveClaimSetOrphansCheck(ctx);

  await runRecursiveStructureLoadCheck(ctx);
  await runRecursiveNoUnreferencedFilesCheck(ctx);
  await runRecursiveAllSectionsReadableCheck(ctx);
  await runRecursiveNoStaleSubskeletonFilesCheck(ctx);
  await runDuplicateSectionFilesInRecursiveSkeletonCheck(ctx);
  await runDuplicateFragmentKeysCheck(ctx);
  await runDuplicateHeadingPathsCheck(ctx);
  await runDuplicateSiblingHeadingsCheck(ctx);
  await runLogicalDocumentLossCheck(ctx);
  await runBodyVsSkeletonHeadingsCheck(ctx);
  await runCanonicalProseUnicodeEscapesCheck(ctx);
  await runBackendStateCheck(ctx);

  await runRestoreTargetRecursiveMatchCheck(ctx);
  await collectSectionLayers(ctx);
  await runRestoreFeasibleCheck(ctx);

  return {
    doc_path: ctx.docPath,
    checks: ctx.checks,
    sections: ctx.sections,
    summary: ctx.summary,
    restore_provenance: ctx.restoreProvenance,
    backend_states: ctx.backendStates,
  };
}
