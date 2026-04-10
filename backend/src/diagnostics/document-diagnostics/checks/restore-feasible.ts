import { gitExec } from "../../../storage/git-repo.js";
import type { DocumentDiagnosticsContext } from "../context.js";

export async function runRestoreFeasibleCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
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
