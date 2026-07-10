import { gitExec } from "../../../storage/git-repo.js";
import type { DocumentDiagnosticsContext } from "../context.js";

/**
 * Restore feasibility is only meaningful when each affected section has a
 * DETERMINISTIC identity — otherwise "restore" cannot know which physical file
 * to bring back to which heading path. Duplicate heading paths and duplicate
 * sibling headings both leave identity ambiguous: two physical files land at
 * the same address, so a merge or restore that keys by heading path silently
 * discards one of them. When either duplicate check has failed, restore
 * feasibility must fail with a "manual repair required" note so the operator
 * cannot mistake diagnostics for a green-light-to-restore. This gates the
 * check BEFORE the never-existed-in-git rung so ambiguous identity is flagged
 * first (it is the earlier, more fundamental defect).
 */
export async function runRestoreFeasibleCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  const ambiguousIdentity = ctx.checks.find(
    (c) => !c.pass && (c.name === "duplicate-heading-paths" || c.name === "duplicate-sibling-headings"),
  );
  if (ambiguousIdentity) {
    ctx.pushCheck(
      "Session / Restore Checks",
      "restore-feasible",
      false,
      `manual repair required — ambiguous heading identity blocks a deterministic restore plan (${ambiguousIdentity.name}${ambiguousIdentity.detail ? `: ${ambiguousIdentity.detail}` : ""}). Choose which physical row keeps the disputed heading before restoring.`,
    );
    return;
  }

  const sections = ctx.sections;
  for (const section of sections) {
    if (section.winner !== "none") {
      section.gitHistoryExists = null;
      continue;
    }
    try {
      const gitRelPath = `${ctx.contentGitPrefix}/${ctx.docPath}.sections/${section.sectionFile}`;
      const result = await gitExec(
        ["log", "--all", "--diff-filter=A", "--format=%H", "--", gitRelPath],
        ctx.dataRoot,
      );
      section.gitHistoryExists = result.trim().length > 0;
    } catch {
      section.gitHistoryExists = false;
    }
  }

  const unrecoverableSections = sections.filter(
    (section) => section.winner === "none" && section.gitHistoryExists === false,
  );
  if (unrecoverableSections.length === 0) {
    ctx.pushCheck("Session / Restore Checks", "restore-feasible", true);
    return;
  }
  const details = unrecoverableSections.map(
    (section) => `Section "${section.headingKey || section.sectionFile}" body file ${section.sectionFile} has never existed in git — restore cannot recover this section. The skeleton must be repaired.`,
  );
  ctx.pushCheck("Session / Restore Checks", "restore-feasible", false, details.join("\n"));
}
