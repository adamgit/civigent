import { getContentGitPrefix, getDataRoot } from "../../storage/data-root.js";
import { gitLogRecent, gitDiffForCommit, isValidSha, type GitLogEntry } from "../../storage/git-repo.js";
import { checkDocPermission } from "../../auth/acl.js";
import type { AuthenticatedWriter } from "../../auth/context.js";
import { DocPath } from "../../types/shared.js";

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

function docPathOfChangedFile(changedFile: string): DocPath | null {
  const prefix = `${getContentGitPrefix()}/`;
  if (!changedFile.startsWith(prefix)) return null;
  const segments = changedFile.slice(prefix.length).split("/").filter(Boolean);
  const sectionsIndex = segments.findIndex((segment) => segment.endsWith(".md.sections"));
  const docSegments =
    sectionsIndex >= 0
      ? [...segments.slice(0, sectionsIndex), segments[sectionsIndex].slice(0, -".sections".length)]
      : segments;
  return DocPath.tryParse(`/${docSegments.join("/")}`);
}

/**
 * Unfiltered-log read scoped to the requester: a repo-wide history (writers,
 * messages, changed paths) must not leak documents the requester cannot read.
 * Keeps only commits touching at least one readable document.
 */
export async function getReadableGitLog(
  writer: AuthenticatedWriter | null,
  query: Omit<GitLogQuery, "docPath">,
): Promise<GitLogEntry[]> {
  const entries = await getGitLog({ limit: query.limit, offset: query.offset });
  const readable: GitLogEntry[] = [];
  for (const entry of entries) {
    const docPaths = [
      ...new Set(
        entry.changed_files
          .map(docPathOfChangedFile)
          .filter((candidate): candidate is DocPath => candidate !== null),
      ),
    ];
    let canReadAny = false;
    for (const candidate of docPaths) {
      if (await checkDocPermission(writer, candidate, "read")) {
        canReadAny = true;
        break;
      }
    }
    if (canReadAny) readable.push(entry);
  }
  return readable;
}

export async function getGitDiff(sha: string) {
  const dataRoot = getDataRoot();
  return gitDiffForCommit(dataRoot, sha);
}
