import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { SectionRef } from "../domain/section-ref.js";
import type { AuthorizedDocRead } from "../auth/authorized-read.js";
import type { HeadingLevel } from "../types/shared.js";
import { ContentLayer, SectionNotFoundError } from "./content-layer.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { gitErrorMeansRevisionResolvesToNoCommit } from "./git-error-meanings.js";
import { gitShowFile, readNulSeparatedFields } from "./git-repo.js";
import { bodyFromDisk, type SectionBody } from "./section-formatting.js";

export interface SectionLineageRow {
  commitSha: string;
  bodyPathAtCommit: string;
  committedAtIso: string;
}

const LINEAGE_COMMIT_PREFIX = "VERSION_";
const NAME_STATUS_CODE = /^[A-Z]\d*$/;
const RENAME_OR_COPY_STATUS = /^[RC]\d*$/;
const DELETION_STATUS = /^D\d*$/;

export async function walkSectionBodyLineage(
  currentBodyRelPath: string,
  sectionsDirectoryRelPrefix: string,
): Promise<SectionLineageRow[]> {
  const confinementPrefix = sectionsDirectoryRelPrefix.endsWith("/")
    ? sectionsDirectoryRelPrefix
    : `${sectionsDirectoryRelPrefix}/`;
  const dataRoot = getDataRoot();
  const rows: SectionLineageRow[] = [];

  const proc = spawn(
    "git",
    [
      "-c", `safe.directory=${dataRoot}`,
      "log",
      "--follow",
      "--name-status",
      "-z",
      `--format=${LINEAGE_COMMIT_PREFIX}%H_%cI`,
      "--",
      currentBodyRelPath,
    ],
    { cwd: dataRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  let spawnError: Error | null = null;
  proc.on("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  const stderrChunks: string[] = [];
  proc.stderr!.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(chunk.toString());
  });

  const fields = readNulSeparatedFields(proc.stdout!);
  const nextField = async (): Promise<string | null> => {
    const next = await fields.next();
    return next.done ? null : next.value;
  };
  const requireField = async (record: string): Promise<string> => {
    const field = await nextField();
    if (field === null) {
      throw new Error(
        `git log --follow produced a truncated ${record} record for "${currentBodyRelPath}"`,
      );
    }
    return field;
  };

  let commitSha = "";
  let committedAtIso = "";
  let stoppedLineageEarly = false;

  try {
    for (;;) {
      const rawField = await nextField();
      if (rawField === null) break;
      const field = rawField.replace(/^[\r\n]+/, "");
      if (field === "") continue;

      if (field.startsWith(LINEAGE_COMMIT_PREFIX)) {
        const payload = field.slice(LINEAGE_COMMIT_PREFIX.length);
        const separator = payload.indexOf("_");
        commitSha = separator < 0 ? payload : payload.slice(0, separator);
        committedAtIso = separator < 0 ? "" : payload.slice(separator + 1);
        continue;
      }

      if (!NAME_STATUS_CODE.test(field)) {
        throw new Error(
          `git log --follow produced an unrecognized name-status field "${field}" for "${currentBodyRelPath}"`,
        );
      }
      if (!commitSha) {
        throw new Error(
          `git log --follow produced a name-status record with no preceding commit header for "${currentBodyRelPath}"`,
        );
      }
      const isDeletion = DELETION_STATUS.test(field);
      if (RENAME_OR_COPY_STATUS.test(field)) await requireField("rename source");
      const bodyPathAtCommit = await requireField("name-status");

      // A deletion ends the lineage: the commit holds no blob at this path, and
      // everything older belongs to whatever file previously occupied it (a
      // restore rewrites historical section files under their original names).
      // Advertising either would break the stable-or-dead contract — the first
      // as a handle that cannot be read, the rest as another file's content
      // served as this section's history.
      if (isDeletion || !bodyPathAtCommit.startsWith(confinementPrefix)) {
        stoppedLineageEarly = true;
        break;
      }
      rows.push({ commitSha, bodyPathAtCommit, committedAtIso });
      commitSha = "";
    }
  } catch (error) {
    throw new Error(
      `git log --follow output could not be read for "${currentBodyRelPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (stoppedLineageEarly) {
    await fields.return(undefined);
    proc.kill();
  }

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("close", (code, signal) => resolve({ code, signal }));
    proc.on("error", () => resolve({ code: proc.exitCode, signal: proc.signalCode }));
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
    }
  });

  if (spawnError) {
    throw new Error(
      `git log --follow spawn failed for "${currentBodyRelPath}": ${(spawnError as Error).message}`,
      { cause: spawnError },
    );
  }

  const terminatedByLineageAbort = stoppedLineageEarly && exit.signal !== null;
  if (!terminatedByLineageAbort && exit.code !== 0) {
    const stderrText = stderrChunks.join("").trim();
    if (gitErrorMeansRevisionResolvesToNoCommit(stderrText)) return rows;
    throw new Error(
      `git log --follow failed for "${currentBodyRelPath}" (${describeGitExit(exit)}): ${stderrText || "no stderr output"}`,
    );
  }

  return rows;
}

function describeGitExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  return exit.signal !== null ? `signal ${exit.signal}` : `exit code ${exit.code}`;
}

const SECTION_HISTORY_HANDLE_CHARS = 16;

export function sectionHistoryVersionHandle(row: SectionLineageRow): string {
  return createHash("sha256")
    .update(`${row.commitSha}\0${row.bodyPathAtCommit}`)
    .digest("hex")
    .slice(0, SECTION_HISTORY_HANDLE_CHARS);
}

export const SECTION_HISTORY_DEFAULT_LIMIT = 50;

export interface SectionHistoryVersionRow {
  version: string;
  committed_at: string;
}

interface ResolvedCurrentSection {
  bodyRelPath: string;
  sectionsDirectoryRelPrefix: string;
  heading: string;
  headingLevel: HeadingLevel;
}

async function resolveCurrentSectionForHistory(
  read: AuthorizedDocRead,
  headingPath: string[],
): Promise<ResolvedCurrentSection> {
  const layer = new ContentLayer(getContentRoot());
  const sections = await layer.getSectionList(read.docPath);
  const wantedKey = SectionRef.headingKey(headingPath);
  const match = sections.find((section) => SectionRef.headingKey(section.headingPath) === wantedKey);
  if (!match) {
    throw new SectionNotFoundError(
      `Section not found: (${read.docPath}, [${headingPath.join(" > ")}]).`,
    );
  }
  const resolved = await layer.resolveSectionFileId(read.docPath, match.sectionFile);
  const dataRoot = getDataRoot();
  return {
    bodyRelPath: path.relative(dataRoot, resolved.absolutePath),
    sectionsDirectoryRelPrefix: path.relative(dataRoot, layer.sectionsDirectory(read.docPath)),
    heading: match.heading,
    headingLevel: match.headingLevel,
  };
}

export async function listSectionHistoryVersions(
  read: AuthorizedDocRead,
  headingPath: string[],
  limit?: number,
  offset?: number,
): Promise<{ versions: SectionHistoryVersionRow[] }> {
  const current = await resolveCurrentSectionForHistory(read, headingPath);
  const lineage = await walkSectionBodyLineage(
    current.bodyRelPath,
    current.sectionsDirectoryRelPrefix,
  );
  const start = offset ?? 0;
  const page = lineage.slice(start, start + (limit ?? SECTION_HISTORY_DEFAULT_LIMIT));
  return {
    versions: page.map((row) => ({
      version: sectionHistoryVersionHandle(row),
      committed_at: row.committedAtIso,
    })),
  };
}

export class SectionHistoryVersionNotFoundError extends Error {}

export async function readSectionHistoryVersion(
  read: AuthorizedDocRead,
  headingPath: string[],
  version: string,
): Promise<{ body: SectionBody; heading: string; headingLevel: HeadingLevel }> {
  const current = await resolveCurrentSectionForHistory(read, headingPath);
  const lineage = await walkSectionBodyLineage(
    current.bodyRelPath,
    current.sectionsDirectoryRelPrefix,
  );
  const row = lineage.find((candidate) => sectionHistoryVersionHandle(candidate) === version);
  if (!row) {
    throw new SectionHistoryVersionNotFoundError(
      `Section history version not found: ${version} for (${read.docPath}, [${headingPath.join(" > ")}]).`,
    );
  }
  const blob = await gitShowFile(getDataRoot(), row.commitSha, row.bodyPathAtCommit);
  return {
    body: bodyFromDisk(blob),
    heading: current.heading,
    headingLevel: current.headingLevel,
  };
}
