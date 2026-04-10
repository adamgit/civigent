import { getHeadSha, gitExec } from "../../../storage/git-repo.js";
import { SectionRef } from "../../../domain/section-ref.js";
import {
  ensureRecursiveSkeleton,
  loadHistoricalRecursiveView,
  type DocumentDiagnosticsContext,
} from "../context.js";

export async function runRestoreTargetRecursiveMatchCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    ctx.restoreProvenance.current_head_sha = await getHeadSha(ctx.dataRoot);
    const logOutput = await gitExec(
      [
        "log",
        "-50",
        "--format=%H%x00%(trailers:key=Restore-Target,valueonly)",
        "--",
        `${ctx.contentGitPrefix}/${ctx.normalizedDocPath}`,
        `${ctx.contentGitPrefix}/${ctx.normalizedDocPath}.sections`,
      ],
      ctx.dataRoot,
    );
    for (const line of logOutput.split("\n").filter(Boolean)) {
      const [commitSha, targetShaRaw] = line.split("\0");
      const targetSha = targetShaRaw?.trim() ?? "";
      if (!targetSha) continue;
      ctx.restoreProvenance.last_restore_commit_sha = commitSha ?? null;
      ctx.restoreProvenance.last_restore_target_sha = targetSha;
      break;
    }
    if (!ctx.restoreProvenance.last_restore_target_sha) return;
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const historicalView = await loadHistoricalRecursiveView(ctx, ctx.restoreProvenance.last_restore_target_sha);
    if (!historicalView) return;

    ctx.restoreProvenance.target_top_level_entries = historicalView.topLevelEntries;
    ctx.restoreProvenance.target_recursive_content_sections = historicalView.recursiveContentSections;
    const currentKeys: Set<string> = new Set(
      recursiveSkeleton.allContentEntries().map((entry) => SectionRef.headingKey(entry.headingPath)),
    );
    const targetKeys: Set<string> = new Set(historicalView.contentHeadingKeys);
    ctx.restoreProvenance.current_only_heading_keys = [...currentKeys].filter((key) => !targetKeys.has(key)).sort();
    ctx.restoreProvenance.target_only_heading_keys = [...targetKeys].filter((key) => !currentKeys.has(key)).sort();
    ctx.restoreProvenance.recursive_content_match =
      ctx.restoreProvenance.current_only_heading_keys.length === 0
      && ctx.restoreProvenance.target_only_heading_keys.length === 0;

    ctx.pushCheck(
      "Session / Restore Checks",
      "restore-target-recursive-match",
      ctx.restoreProvenance.recursive_content_match,
      ctx.restoreProvenance.recursive_content_match
        ? undefined
        : `current-only: ${ctx.restoreProvenance.current_only_heading_keys.join(", ") || "(none)"} | target-only: ${ctx.restoreProvenance.target_only_heading_keys.join(", ") || "(none)"}`,
    );
  } catch (err) {
    ctx.pushCheck("Session / Restore Checks", "restore-target-recursive-match", false, err instanceof Error ? err.message : String(err));
  }
}
