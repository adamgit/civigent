import path from "node:path";
import { pathExists, readFileBufferIfExists } from "./fs-primitives.js";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { checkDocPermission } from "../auth/acl.js";
import type { AuthenticatedWriter } from "../auth/context.js";
import { ContentLayer, DocumentNotFoundError, SectionNotFoundError } from "./content-layer.js";
import {
  browseFolderPathToContentRelativeFsPath,
  readDocumentsTreeUnfiltered,
  DocumentsTreePathNotFoundError,
  InvalidDocumentsTreePathError,
} from "./documents-tree.js";
import { getContentRoot } from "./data-root.js";
import { docPathFromContentRelativeFsPath, InvalidDocPathError, resolveDocPathUnderContent } from "./path-utils.js";
import type { DocumentTreeEntry, JsonValue } from "../types/shared.js";
import { expectJsonObject, parseJson } from "../types/shared.js";
import { DocPath } from "../types/shared.js";

export const DISCOVERY_NOT_FOUND_OR_NO_ACCESS_MESSAGE = "Not found or you do not have read access";

export interface ListDocumentsRow {
  doc_path: string;
  section_count: number;
}

export interface ListSectionsRow {
  doc_path: string;
  heading: string;
  heading_path: string[];
  body_size_bytes: number;
}

/**
 * An EXPLICIT per-row read failure in a multi-subject fan-out (claim-review 04):
 * a doc/section the fan-out was asked to read but whose body/structure could not
 * be read. Surfaced alongside the good rows — NEVER silently dropped — so the
 * frontend can render a "this document failed to load" marker per failed row.
 */
export interface DiscoveryFailure {
  doc_path: string;
  heading_path?: string[];
  error: string;
}

export interface ListDocumentsResult {
  rows: ListDocumentsRow[];
  failures: DiscoveryFailure[];
}

export interface ListSectionsResult {
  rows: ListSectionsRow[];
  failures: DiscoveryFailure[];
}

/**
 * What a search hit LOCATED — the four are distinct kinds of evidence, not
 * severity tiers:
 *  - `body`         — text inside a section body (the original ripgrep pipeline)
 *  - `heading`      — a section heading
 *  - `filename`     — a document's filename stem (leaf without `.md`)
 *  - `path_segment` — a folder name somewhere in a readable document's path
 */
export type SearchHitKind = "body" | "heading" | "filename" | "path_segment";

export interface SearchTextMatch {
  kind: SearchHitKind;
  /**
   * The subject the hit belongs to. For `body` / `heading` / `filename` this is
   * the DOCUMENT path. For `path_segment` it is the matched FOLDER PREFIX (e.g.
   * `/a/b` for a hit on segment `b`) — NOT a document, so consumers must not
   * assume a `.md` leaf or an openable document route.
   */
  doc_path: string;
  /**
   * Section heading path for `body` and `heading` hits. Empty (`[]`) for
   * `filename` and `path_segment`, which are not section-scoped.
   */
  heading_path: string[];
  /**
   * The text the offset is measured against, per kind:
   *  - `body`         — surrounding body slice (`context_bytes` either side)
   *  - `heading`      — the heading text
   *  - `filename`     — the filename stem
   *  - `path_segment` — the full folder prefix (`doc_path`)
   */
  match_context: string;
  /**
   * Byte offset of the match. For `body` this is the offset within the section
   * FILE (the historical meaning). For every non-body kind it is the offset
   * WITHIN `match_context`.
   */
  match_offset_bytes: number;
}

export interface SearchTextTimings {
  total_ms: number;
  scope_and_acl_ms: number;
  ripgrep_ms: number;
  match_mapping_ms: number;
  context_read_ms: number;
}

export interface SearchTextResult {
  matches: SearchTextMatch[];
  timings: SearchTextTimings;
  /** Per-row read failures (claim-review 04) — surfaced, never silently dropped. */
  failures: DiscoveryFailure[];
}

export interface SearchTextInput {
  pattern: string;
  syntax: "literal" | "regexp";
  root?: string;
  case_sensitive?: boolean;
  max_results?: number;
  context_bytes?: number;
}

export class DiscoveryValidationError extends Error {}
export class DiscoveryNotFoundError extends Error {
  constructor(message: string = DISCOVERY_NOT_FOUND_OR_NO_ACCESS_MESSAGE) {
    super(message);
  }
}
export class SearchTextPatternError extends Error {}
export class SearchTextExecutionError extends Error {}

type ScopeKind = "root" | "folder" | "document";

interface ParsedScope {
  normalized_path: string;
  kind: ScopeKind;
}

interface SearchTextInputNormalized {
  pattern: string;
  syntax: "literal" | "regexp";
  root: string;
  case_sensitive: boolean;
  max_results: number;
  context_bytes: number;
}

interface SearchableSectionFile {
  docPath: DocPath;
  headingPath: string[];
  absolutePath: string;
}

interface RawRipgrepMatch {
  absolutePath: string;
  startByte: number;
  endByte: number;
}

function parseDiscoveryScopePath(rawPath: string | undefined, fieldName: string): ParsedScope {
  const trimmed = (rawPath ?? "/").trim();
  if (trimmed.length === 0) {
    return { normalized_path: "/", kind: "root" };
  }

  const slashNormalized = trimmed.replaceAll("\\", "/");
  if (!slashNormalized.startsWith("/")) {
    throw new DiscoveryValidationError(`${fieldName} must be an absolute canonical path.`);
  }

  const rawSegments = slashNormalized.split("/").filter(Boolean);
  if (rawSegments.some((segment) => segment === "." || segment === "..")) {
    throw new DiscoveryValidationError(`Invalid ${fieldName}: traversal segments are not allowed.`);
  }

  const normalized = path.posix.normalize(slashNormalized);
  if (!normalized.startsWith("/")) {
    throw new DiscoveryValidationError(`${fieldName} must stay under root.`);
  }

  const normalizedWithoutTrailingSlash =
    normalized !== "/" && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (normalizedWithoutTrailingSlash.includes("/../") || normalizedWithoutTrailingSlash === "/..") {
    throw new DiscoveryValidationError(`Invalid ${fieldName}: traversal is not allowed.`);
  }

  if (normalizedWithoutTrailingSlash === "/") {
    return { normalized_path: "/", kind: "root" };
  }

  if (normalizedWithoutTrailingSlash.endsWith(".md")) {
    return { normalized_path: normalizedWithoutTrailingSlash, kind: "document" };
  }

  return { normalized_path: normalizedWithoutTrailingSlash, kind: "folder" };
}

function flattenDocumentPaths(entries: DocumentTreeEntry[]): DocPath[] {
  const docPaths: DocPath[] = [];
  const walk = (nodes: DocumentTreeEntry[]): void => {
    for (const node of nodes) {
      if (node.type === "file") {
        docPaths.push(DocPath.parse(node.path));
        continue;
      }
      walk(node.children ?? []);
    }
  };
  walk(entries);
  return docPaths;
}

async function resolveDocScope(
  writer: AuthenticatedWriter | null,
  normalizedDocPath: string,
): Promise<DocPath[]> {
  const contentRoot = getContentRoot();
  let absoluteDocPath: string;
  try {
    absoluteDocPath = resolveDocPathUnderContent(contentRoot, normalizedDocPath);
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      throw new DiscoveryNotFoundError();
    }
    throw error;
  }
  if (!(await pathExists(absoluteDocPath))) {
    throw new DiscoveryNotFoundError();
  }

  const readable = await checkDocPermission(writer, normalizedDocPath, "read");
  if (!readable) {
    throw new DiscoveryNotFoundError();
  }
  return [DocPath.parse(normalizedDocPath)];
}

async function resolveFolderScope(
  writer: AuthenticatedWriter | null,
  normalizedFolderPath: string,
): Promise<DocPath[]> {
  let tree: DocumentTreeEntry[];
  try {
    tree = await readDocumentsTreeUnfiltered(normalizedFolderPath, true);
  } catch (error) {
    if (error instanceof InvalidDocumentsTreePathError) {
      throw new DiscoveryValidationError(error.message);
    }
    if (error instanceof DocumentsTreePathNotFoundError) {
      throw new DiscoveryNotFoundError();
    }
    throw error;
  }

  const candidateDocs = flattenDocumentPaths(tree);
  const readability = await Promise.all(
    candidateDocs.map(async (docPath) => ({
      docPath,
      readable: await checkDocPermission(writer, docPath, "read"),
    })),
  );
  const readableDocs = readability.filter((entry) => entry.readable).map((entry) => entry.docPath);
  if (normalizedFolderPath !== "/" && readableDocs.length === 0) {
    throw new DiscoveryNotFoundError();
  }
  return readableDocs;
}

async function resolveScopedReadableDocuments(
  writer: AuthenticatedWriter | null,
  rawScopePath: string | undefined,
  fieldName: string,
): Promise<{ scope: ParsedScope; docPaths: DocPath[] }> {
  const scope = parseDiscoveryScopePath(rawScopePath, fieldName);
  if (scope.kind === "document") {
    const docPaths = await resolveDocScope(writer, scope.normalized_path);
    return { scope, docPaths };
  }
  const docPaths = await resolveFolderScope(writer, scope.normalized_path);
  return { scope, docPaths };
}

function parseStrictOptionalInteger(
  value: unknown,
  fieldName: string,
  minimum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new DiscoveryValidationError(`${fieldName} must be an integer >= ${minimum}.`);
  }
  return value;
}

function normalizeSearchTextInput(input: SearchTextInput): SearchTextInputNormalized {
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    throw new DiscoveryValidationError("pattern is required and must be a non-empty string.");
  }
  if (input.syntax !== "literal" && input.syntax !== "regexp") {
    throw new DiscoveryValidationError('syntax is required and must be "literal" or "regexp".');
  }
  if (input.case_sensitive !== undefined && typeof input.case_sensitive !== "boolean") {
    throw new DiscoveryValidationError("case_sensitive must be a boolean.");
  }

  const maxResults = parseStrictOptionalInteger(input.max_results, "max_results", 1) ?? 20;
  const contextBytes = parseStrictOptionalInteger(input.context_bytes, "context_bytes", 0) ?? 100;

  return {
    pattern: input.pattern,
    syntax: input.syntax,
    root: input.root ?? "/",
    case_sensitive: input.case_sensitive ?? false,
    max_results: maxResults,
    context_bytes: contextBytes,
  };
}

function extractContext(content: Buffer, startByte: number, endByte: number, contextBytes: number): string {
  const contextStart = Math.max(0, startByte - contextBytes);
  const contextEnd = Math.min(content.length, endByte + contextBytes);
  return content.subarray(contextStart, contextEnd).toString("utf8");
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function deriveDocPathFromMatchedFile(contentRoot: string, absolutePath: string): DocPath | null {
  const relative = path.relative(contentRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  const docIndex = segments.findIndex((segment) => segment.endsWith(".md.sections"));
  if (docIndex < 0) {
    return null;
  }

  const docLeaf = segments[docIndex].slice(0, -".sections".length);
  return docPathFromContentRelativeFsPath([...segments.slice(0, docIndex), docLeaf].join("/"));
}

function collectRawMatchesFromRgJsonLine(
  line: string,
  results: RawRipgrepMatch[],
  maxResults: number,
): void {
  if (line.trim().length === 0) return;

  // ripgrep --json emits one JSON object per line. parseJson lets a genuine
  // SyntaxError propagate (a non-JSON line from `rg --json` is unexpected).
  const event = expectJsonObject(parseJson(line), "ripgrep --json line");

  // Non-`match` events (begin/end/summary/context) are not failures — ignore them.
  if (event["type"] !== "match") return;

  // A `match` event with a malformed shape IS a failure: surface it with field detail.
  const data = expectJsonObject(event["data"], "ripgrep match event `data`");
  const pathObj = expectJsonObject(data["path"], "ripgrep match `data.path`");
  const absolutePath = pathObj["text"];
  const absoluteOffset = data["absolute_offset"];
  const submatches = data["submatches"];
  if (typeof absolutePath !== "string") {
    throw new SearchTextExecutionError(`ripgrep match event has a non-string data.path.text: ${JSON.stringify(absolutePath)}`);
  }
  if (typeof absoluteOffset !== "number") {
    throw new SearchTextExecutionError(`ripgrep match event has a non-number data.absolute_offset: ${JSON.stringify(absoluteOffset)}`);
  }
  if (!isJsonValueArray(submatches)) {
    throw new SearchTextExecutionError(`ripgrep match event data.submatches is not an array: ${JSON.stringify(submatches)}`);
  }

  for (const submatchValue of submatches) {
    const submatch = expectJsonObject(submatchValue, "ripgrep submatch");
    const start = submatch["start"];
    const end = submatch["end"];
    if (typeof start !== "number" || typeof end !== "number") {
      throw new SearchTextExecutionError(`ripgrep submatch has non-number start/end: ${JSON.stringify(submatchValue)}`);
    }
    results.push({
      absolutePath,
      startByte: absoluteOffset + start,
      endByte: absoluteOffset + end,
    });
    if (results.length >= maxResults) {
      return;
    }
  }
}

/** Local array guard — `Array.isArray` does not narrow a `readonly JsonValue[]` union member. */
function isJsonValueArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

async function runRipgrepInScope(
  pattern: string,
  syntax: "literal" | "regexp",
  caseSensitive: boolean,
  absoluteScopePath: string,
  maxResults: number,
): Promise<RawRipgrepMatch[]> {
  return await new Promise<RawRipgrepMatch[]>((resolve, reject) => {
    const args = ["--json", "--no-messages", "--glob", "**/*.sections/**"];
    if (syntax === "literal") {
      args.push("--fixed-strings");
    }
    if (!caseSensitive) {
      args.push("--ignore-case");
    }
    args.push("-e", pattern, "--", absoluteScopePath);

    const child = spawn("rg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let shouldStopEarly = false;
    const matches: RawRipgrepMatch[] = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const settleResolve = (value: RawRipgrepMatch[]): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const processLine = (line: string): void => {
      collectRawMatchesFromRgJsonLine(line, matches, maxResults);
      if (matches.length >= maxResults && !shouldStopEarly) {
        shouldStopEarly = true;
        child.kill("SIGTERM");
      }
    };

    child.on("error", (error) => {
      // A spawn ENOENT here means the ripgrep EXECUTABLE is missing — this is a
      // distinct execution failure, NOT a content-path absence, so it is modelled
      // separately and never routed through the absence-aware fs helpers.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        settleReject(new SearchTextExecutionError("ripgrep binary not found. Install ripgrep in the runtime image."));
        return;
      }
      settleReject(error instanceof Error ? error : new Error(String(error)));
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim().length > 0) {
        processLine(stdoutBuffer);
      }

      const stderrText = stderrBuffer.trim();

      if (shouldStopEarly) {
        settleResolve(matches.slice(0, maxResults));
        return;
      }

      if (code === 0 || code === 1) {
        settleResolve(matches);
        return;
      }

      if (code === 2) {
        if (syntax === "regexp") {
          const reason = stderrText || "ripgrep rejected the regexp pattern.";
          settleReject(new SearchTextPatternError(reason));
          return;
        }

        const reason =
          stderrText ||
          "ripgrep failed while running literal search (exit code 2). This usually indicates an execution or file-path issue, not an invalid literal pattern.";
        settleReject(new SearchTextExecutionError(reason));
        return;
      }

      const reason = stderrText || `ripgrep exited with code ${code ?? "unknown"}.`;
      settleReject(new SearchTextExecutionError(reason));
    });
  });
}

/** Byte span of a match WITHIN a single candidate string (UTF-8 offsets). */
interface CandidateMatchSpan {
  start: number;
  end: number;
}

/**
 * Match structural candidate strings (folder segments / filename stems /
 * headings) against the SAME regex engine and the SAME pattern flags as the
 * body search, by piping the candidates one-per-line into `rg --json` over
 * stdin.
 *
 * This exists so there is exactly ONE regex implementation in search: a second
 * engine (JS `RegExp`) would silently disagree with ripgrep on syntax, and an
 * invalid pattern would need its own validation path. Here an invalid regexp
 * still comes back as ripgrep exit code 2 → `SearchTextPatternError`, exactly
 * as it does for bodies.
 *
 * Returns first-match spans keyed by the candidate's INDEX in `candidates`
 * (unmatched candidates are simply absent). Line numbers from `rg` are the
 * only mapping back to candidates, so `--line-number` is passed explicitly —
 * ripgrep does not guarantee it for stdin input.
 */
async function matchCandidatesWithRipgrep(
  pattern: string,
  syntax: "literal" | "regexp",
  caseSensitive: boolean,
  candidates: readonly string[],
): Promise<Map<number, CandidateMatchSpan>> {
  const spans = new Map<number, CandidateMatchSpan>();
  if (candidates.length === 0) {
    return spans;
  }

  // Candidates are single path segments, filename stems, or headings — none of
  // which can contain a newline. The one-per-line stdin encoding depends on it,
  // so this is an ASSERTION, not a case to sanitize around.
  for (const candidate of candidates) {
    if (candidate.includes("\n") || candidate.includes("\r")) {
      throw new SearchTextExecutionError(
        `Structural search candidate contains a line break, which the one-per-line stdin encoding cannot represent: ${JSON.stringify(candidate)}`,
      );
    }
  }

  return await new Promise<Map<number, CandidateMatchSpan>>((resolve, reject) => {
    const args = ["--json", "--no-messages", "--line-number"];
    if (syntax === "literal") {
      args.push("--fixed-strings");
    }
    if (!caseSensitive) {
      args.push("--ignore-case");
    }
    args.push("-e", pattern, "--", "-");

    const child = spawn("rg", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    // A pattern rejection makes rg exit before it drains stdin, so our write can
    // fail with EPIPE. That error is RETAINED (never swallowed) and re-raised
    // below only if the exit code does not already carry the real cause.
    let stdinError: Error | null = null;

    const settleResolve = (value: Map<number, CandidateMatchSpan>): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const processLine = (line: string): void => {
      if (line.trim().length === 0) return;
      const event = expectJsonObject(parseJson(line), "ripgrep --json line");
      if (event["type"] !== "match") return;

      const data = expectJsonObject(event["data"], "ripgrep match event `data`");
      const lineNumber = data["line_number"];
      const submatches = data["submatches"];
      if (typeof lineNumber !== "number") {
        throw new SearchTextExecutionError(
          `ripgrep stdin match event has a non-number data.line_number: ${JSON.stringify(lineNumber)}`,
        );
      }
      if (!isJsonValueArray(submatches)) {
        throw new SearchTextExecutionError(
          `ripgrep match event data.submatches is not an array: ${JSON.stringify(submatches)}`,
        );
      }

      const candidateIndex = lineNumber - 1;
      if (candidateIndex < 0 || candidateIndex >= candidates.length) {
        throw new SearchTextExecutionError(
          `ripgrep reported line ${lineNumber} for a ${candidates.length}-candidate stdin batch.`,
        );
      }
      // First match per candidate wins; later submatches on the same line are
      // the same candidate and add nothing a locator hit can show.
      if (spans.has(candidateIndex)) return;

      const firstSubmatch = expectJsonObject(submatches[0], "ripgrep submatch");
      const start = firstSubmatch["start"];
      const end = firstSubmatch["end"];
      if (typeof start !== "number" || typeof end !== "number") {
        throw new SearchTextExecutionError(
          `ripgrep submatch has non-number start/end: ${JSON.stringify(submatches[0])}`,
        );
      }
      spans.set(candidateIndex, { start, end });
    };

    child.on("error", (error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        settleReject(new SearchTextExecutionError("ripgrep binary not found. Install ripgrep in the runtime image."));
        return;
      }
      settleReject(error instanceof Error ? error : new Error(String(error)));
    });

    child.stdin.on("error", (error: Error) => {
      stdinError = error;
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim().length > 0) {
        processLine(stdoutBuffer);
      }

      const stderrText = stderrBuffer.trim();

      if (code === 2) {
        if (syntax === "regexp") {
          settleReject(new SearchTextPatternError(stderrText || "ripgrep rejected the regexp pattern."));
          return;
        }
        settleReject(
          new SearchTextExecutionError(
            stderrText ||
              "ripgrep failed while matching structural candidates (exit code 2). This usually indicates an execution issue, not an invalid literal pattern.",
          ),
        );
        return;
      }

      if (code !== 0 && code !== 1) {
        settleReject(new SearchTextExecutionError(stderrText || `ripgrep exited with code ${code ?? "unknown"}.`));
        return;
      }

      // Exit 0/1 with a failed stdin write means we fed rg an incomplete batch
      // and its "no more matches" answer is not trustworthy — raise the write
      // failure verbatim rather than returning a silently short result.
      if (stdinError !== null) {
        settleReject(stdinError);
        return;
      }

      settleResolve(spans);
    });

    child.stdin.end(candidates.join("\n") + "\n", "utf8");
  });
}

/**
 * Every distinct FOLDER prefix of the scoped documents, e.g. `/a/b/c.md` yields
 * `/a` and `/a/b`. The `.md` leaf is never a folder and is never emitted.
 * Sorted so hit order is deterministic across runs.
 */
function collectFolderPrefixes(docPaths: readonly DocPath[]): string[] {
  const prefixes = new Set<string>();
  for (const docPath of docPaths) {
    const segments = docPath.split("/").filter(Boolean);
    for (let depth = 1; depth < segments.length; depth += 1) {
      prefixes.add(`/${segments.slice(0, depth).join("/")}`);
    }
  }
  return [...prefixes].sort();
}

/**
 * `path_segment` hits: a folder NAME in the path of a readable document matched
 * the pattern. `doc_path` is the folder prefix itself (not a document), and
 * `match_context` is that whole prefix so the UI can show where the folder sits.
 *
 * Only the LAST segment of each prefix is matched — the ancestors are their own
 * prefixes and get their own hit, so matching the whole path here would emit the
 * same folder name once per descendant level.
 */
async function collectPathSegmentHits(
  normalized: SearchTextInputNormalized,
  docPaths: readonly DocPath[],
): Promise<SearchTextMatch[]> {
  const prefixes = collectFolderPrefixes(docPaths);
  const segments = prefixes.map((prefix) => prefix.slice(prefix.lastIndexOf("/") + 1));
  const spans = await matchCandidatesWithRipgrep(
    normalized.pattern,
    normalized.syntax,
    normalized.case_sensitive,
    segments,
  );

  const hits: SearchTextMatch[] = [];
  for (let index = 0; index < prefixes.length; index += 1) {
    const span = spans.get(index);
    if (span === undefined) continue;
    const prefix = prefixes[index];
    // The span is a byte offset within the SEGMENT; `match_offset_bytes` is
    // relative to `match_context` (the full prefix), so shift it by where the
    // last segment starts in that prefix.
    const segmentByteOffset = Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(segments[index], "utf8");
    hits.push({
      kind: "path_segment",
      doc_path: prefix,
      heading_path: [],
      match_context: prefix,
      match_offset_bytes: segmentByteOffset + span.start,
    });
  }
  return hits;
}

/**
 * `filename` hits: a document's own name matched the pattern.
 *
 * Matching is against the STEM (leaf without `.md`) — the title the document
 * cards display. The extension is uniform across every document, so including
 * it would make `md` (or `\.m`) hit literally every document in scope, which is
 * noise, not a locator.
 */
async function collectFilenameHits(
  normalized: SearchTextInputNormalized,
  docPaths: readonly DocPath[],
): Promise<SearchTextMatch[]> {
  const stems = docPaths.map((docPath) => {
    const leaf = docPath.slice(docPath.lastIndexOf("/") + 1);
    return leaf.endsWith(".md") ? leaf.slice(0, -".md".length) : leaf;
  });
  const spans = await matchCandidatesWithRipgrep(
    normalized.pattern,
    normalized.syntax,
    normalized.case_sensitive,
    stems,
  );

  const hits: SearchTextMatch[] = [];
  for (let index = 0; index < docPaths.length; index += 1) {
    const span = spans.get(index);
    if (span === undefined) continue;
    hits.push({
      kind: "filename",
      doc_path: docPaths[index],
      heading_path: [],
      // `match_context` is the stem, so the span needs no translation.
      match_context: stems[index],
      match_offset_bytes: span.start,
    });
  }
  return hits;
}

/**
 * `heading` hits: a section heading matched the pattern.
 *
 * Headings live in the document skeleton, not in the section body files the
 * body ripgrep run walks, so they need their own read. Structure reads fan out
 * (`Promise.all`) the way `listReadableDocuments` does; a doc whose structure
 * cannot be read becomes a claim-review-04 `failures` row and the rest of the
 * search still returns. All headings across all docs go through ONE ripgrep
 * batch.
 */
async function collectHeadingHits(
  normalized: SearchTextInputNormalized,
  docPaths: readonly DocPath[],
  layer: ContentLayer,
): Promise<{ hits: SearchTextMatch[]; failures: DiscoveryFailure[] }> {
  interface HeadingCandidate {
    docPath: DocPath;
    headingPath: string[];
    heading: string;
  }

  const perDoc = await Promise.all(
    docPaths.map(async (docPath): Promise<{ candidates: HeadingCandidate[] } | { failure: DiscoveryFailure }> => {
      try {
        const sections = await layer.getSectionDiscoveryList(docPath);
        return {
          candidates: sections
            .filter((section) => section.heading.length > 0)
            .map((section) => ({ docPath, headingPath: section.headingPath, heading: section.heading })),
        };
      } catch (error) {
        return { failure: { doc_path: docPath, error: error instanceof Error ? error.message : String(error) } };
      }
    }),
  );

  const candidates: HeadingCandidate[] = [];
  const failures: DiscoveryFailure[] = [];
  for (const entry of perDoc) {
    if ("failure" in entry) {
      failures.push(entry.failure);
      continue;
    }
    candidates.push(...entry.candidates);
  }

  const spans = await matchCandidatesWithRipgrep(
    normalized.pattern,
    normalized.syntax,
    normalized.case_sensitive,
    candidates.map((candidate) => candidate.heading),
  );

  const hits: SearchTextMatch[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const span = spans.get(index);
    if (span === undefined) continue;
    const candidate = candidates[index];
    hits.push({
      kind: "heading",
      doc_path: candidate.docPath,
      heading_path: [...candidate.headingPath],
      // `match_context` is the heading text, so the span needs no translation.
      match_context: candidate.heading,
      match_offset_bytes: span.start,
    });
  }
  return { hits, failures };
}

/**
 * Merge structural locators with body matches under `max_results`.
 *
 * Structural hits come FIRST and are never starved: a run whose body matches
 * alone would fill the budget must still tell you which folders/files/headings
 * carry the term, since that is the whole point of the locator kinds. Body
 * matches fill whatever slots remain. If the structural hits alone overflow the
 * budget they are sliced in the fixed cross-kind order below.
 *
 * Order is fixed (broadest locator → narrowest → body) and stable within each
 * kind, so a repeated search returns the same list in the same order.
 */
function mergeSearchHits(
  pathSegmentHits: readonly SearchTextMatch[],
  filenameHits: readonly SearchTextMatch[],
  headingHits: readonly SearchTextMatch[],
  bodyHits: readonly SearchTextMatch[],
  maxResults: number,
): SearchTextMatch[] {
  const structural = [...pathSegmentHits, ...filenameHits, ...headingHits];
  if (structural.length >= maxResults) {
    return structural.slice(0, maxResults);
  }
  return [...structural, ...bodyHits.slice(0, maxResults - structural.length)];
}

export async function listReadableDocuments(
  writer: AuthenticatedWriter | null,
  root: string | undefined,
): Promise<ListDocumentsResult> {
  const { docPaths } = await resolveScopedReadableDocuments(writer, root, "root");
  const layer = new ContentLayer(getContentRoot());

  const results = await Promise.all(
    docPaths.map(async (docPath): Promise<{ row?: ListDocumentsRow; failure?: DiscoveryFailure }> => {
      try {
        const sections = await layer.getSectionDiscoveryList(docPath);
        return { row: { doc_path: docPath, section_count: sections.length } };
      } catch (error) {
        // FAIL LOUD per-row (claim-review 04): a doc the ACL listed as readable
        // whose structure can't be read is surfaced as an explicit failure, NOT
        // silently dropped — the other rows still render.
        return { failure: { doc_path: docPath, error: error instanceof Error ? error.message : String(error) } };
      }
    }),
  );

  return {
    rows: results.filter((r): r is { row: ListDocumentsRow } => r.row !== undefined).map((r) => r.row),
    failures: results.filter((r): r is { failure: DiscoveryFailure } => r.failure !== undefined).map((r) => r.failure),
  };
}

export async function listReadableSections(
  writer: AuthenticatedWriter | null,
  pathScope: string | undefined,
): Promise<ListSectionsResult> {
  const { docPaths } = await resolveScopedReadableDocuments(writer, pathScope, "path");
  const layer = new ContentLayer(getContentRoot());
  const rows: ListSectionsRow[] = [];
  const failures: DiscoveryFailure[] = [];

  for (const docPath of docPaths) {
    let sections;
    try {
      sections = await layer.getSectionDiscoveryList(docPath);
    } catch (error) {
      // FAIL LOUD per-row (claim-review 04): surface the failed doc, keep the rest.
      failures.push({ doc_path: docPath, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    for (const section of sections) {
      rows.push({
        doc_path: docPath,
        heading: section.heading,
        heading_path: section.headingPath,
        body_size_bytes: section.bodySizeBytes,
      });
    }
  }

  return { rows, failures };
}

export async function searchReadableText(
  writer: AuthenticatedWriter | null,
  input: SearchTextInput,
): Promise<SearchTextResult> {
  const totalStart = performance.now();
  const normalized = normalizeSearchTextInput(input);
  const scopeStart = performance.now();
  const { scope, docPaths } = await resolveScopedReadableDocuments(writer, normalized.root, "root");
  const scopeAndAclMs = performance.now() - scopeStart;
  const contentRoot = getContentRoot();
  const readableDocSet = new Set(docPaths);
  // Per-row read failures (claim-review 04): a ripgrep match whose section can't
  // be resolved, or whose matched file vanished, is surfaced — not silently
  // dropped. (ACL-scope filtering and stale-path dedup are legitimate non-failure
  // skips and are NOT collected here.)
  const failures: DiscoveryFailure[] = [];
  const layer = new ContentLayer(contentRoot);

  // Structural locators (path_segment / filename / heading) are collected for the
  // SAME ACL-scoped document set as the body run, and are independent of it: a
  // pattern that appears only in a folder name or a heading still has to come
  // back. Their wall time folds into `match_mapping_ms` rather than adding a
  // timings field the UI does not display.
  const locatorStart = performance.now();
  const [pathSegmentHits, filenameHits, headingResult] = await Promise.all([
    collectPathSegmentHits(normalized, docPaths),
    collectFilenameHits(normalized, docPaths),
    collectHeadingHits(normalized, docPaths, layer),
  ]);
  const locatorMs = performance.now() - locatorStart;
  failures.push(...headingResult.failures);
  const headingHits = headingResult.hits;

  const finishWithoutBodyMatches = (ripgrepMs: number): SearchTextResult => ({
    matches: mergeSearchHits(pathSegmentHits, filenameHits, headingHits, [], normalized.max_results),
    timings: {
      total_ms: roundMs(performance.now() - totalStart),
      scope_and_acl_ms: roundMs(scopeAndAclMs),
      ripgrep_ms: roundMs(ripgrepMs),
      match_mapping_ms: roundMs(locatorMs),
      context_read_ms: 0,
    },
    failures,
  });

  let absoluteSearchScope = contentRoot;
  if (scope.kind === "folder") {
    absoluteSearchScope = path.join(contentRoot, browseFolderPathToContentRelativeFsPath(scope.normalized_path));
  } else if (scope.kind === "document") {
    absoluteSearchScope = resolveDocPathUnderContent(contentRoot, scope.normalized_path) + ".sections";
    // Optional dir: a document with no `.sections/` yet is a valid empty state
    // (NOT a failure) — no BODY matches are possible, but its filename, folder
    // path, and any headings in its skeleton can still have matched.
    if (!(await pathExists(absoluteSearchScope))) {
      return finishWithoutBodyMatches(0);
    }
  }

  const ripgrepStart = performance.now();
  const rawMatches = await runRipgrepInScope(
    normalized.pattern,
    normalized.syntax,
    normalized.case_sensitive,
    absoluteSearchScope,
    normalized.max_results,
  );
  const ripgrepMs = performance.now() - ripgrepStart;
  // No body matches does NOT mean no results — structural locators stand alone
  // (a heading-only or filename-only hit is exactly this case).
  if (rawMatches.length === 0) {
    return finishWithoutBodyMatches(ripgrepMs);
  }

  const matchMappingStart = performance.now();
  const searchableFiles = new Map<string, SearchableSectionFile>();

  for (const rawMatch of rawMatches) {
    const docPath = deriveDocPathFromMatchedFile(contentRoot, rawMatch.absolutePath);
    if (!docPath || !readableDocSet.has(docPath)) {
      continue;
    }

    const sectionFileId = path.basename(rawMatch.absolutePath);
    try {
      const resolved = await layer.resolveSectionFileId(docPath, sectionFileId);
      if (resolved.absolutePath !== rawMatch.absolutePath) {
        continue;
      }
      searchableFiles.set(`${rawMatch.absolutePath}:${rawMatch.startByte}:${rawMatch.endByte}`, {
        docPath,
        headingPath: resolved.headingPath,
        absolutePath: rawMatch.absolutePath,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundError || error instanceof SectionNotFoundError) {
        // A ripgrep match in a doc/section that no longer resolves is corruption /
        // staleness — surface it as a per-row failure, keep the other matches.
        failures.push({ doc_path: docPath, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      throw error;
    }
  }
  const matchMappingMs = performance.now() - matchMappingStart;

  const fileCache = new Map<string, Buffer>();
  const bodyMatches: SearchTextMatch[] = [];
  let contextReadMs = 0;
  for (const match of rawMatches) {
    if (bodyMatches.length >= normalized.max_results) break;

    const fileMeta = searchableFiles.get(`${match.absolutePath}:${match.startByte}:${match.endByte}`);
    if (!fileMeta) continue;

    let fileContent = fileCache.get(fileMeta.absolutePath);
    if (!fileContent) {
      const contextReadStart = performance.now();
      const readContent = await readFileBufferIfExists(fileMeta.absolutePath);
      contextReadMs += performance.now() - contextReadStart;
      if (readContent === null) {
        // The file ripgrep matched vanished before we could read its context —
        // surface as a per-row failure rather than silently dropping the match.
        failures.push({ doc_path: fileMeta.docPath, heading_path: [...fileMeta.headingPath], error: `Matched file disappeared before context read: ${fileMeta.absolutePath}` });
        continue;
      }
      fileContent = readContent;
      fileCache.set(fileMeta.absolutePath, fileContent);
    }

    bodyMatches.push({
      kind: "body",
      doc_path: fileMeta.docPath,
      heading_path: [...fileMeta.headingPath],
      match_context: extractContext(fileContent, match.startByte, match.endByte, normalized.context_bytes),
      match_offset_bytes: match.startByte,
    });
  }

  return {
    matches: mergeSearchHits(pathSegmentHits, filenameHits, headingHits, bodyMatches, normalized.max_results),
    timings: {
      total_ms: roundMs(performance.now() - totalStart),
      scope_and_acl_ms: roundMs(scopeAndAclMs),
      ripgrep_ms: roundMs(ripgrepMs),
      match_mapping_ms: roundMs(locatorMs + matchMappingMs),
      context_read_ms: roundMs(contextReadMs),
    },
    failures,
  };
}
