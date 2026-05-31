import { getDataRoot } from "../../storage/data-root.js";
import { gitLogRecent, gitDiffForCommit, isValidSha } from "../../storage/git-repo.js";

export { isValidSha };

export interface GitLogQuery {
  limit: number;
  offset: number;
  docPath?: string;
}

export async function getGitLog(query: GitLogQuery) {
  const dataRoot = getDataRoot();
  return gitLogRecent(dataRoot, { limit: query.limit, offset: query.offset, docPath: query.docPath });
}

export async function getGitDiff(sha: string) {
  const dataRoot = getDataRoot();
  return gitDiffForCommit(dataRoot, sha);
}
