import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { checkDocPermission } from "../auth/acl.js";
import type { AuthenticatedWriter } from "../auth/context.js";
import { ContentLayer, DocumentNotFoundError, SectionNotFoundError } from "./content-layer.js";
import {
  readDocumentsTree,
  DocumentsTreePathNotFoundError,
  InvalidDocumentsTreePathError,
} from "./documents-tree.js";
import { getContentRoot } from "./data-root.js";
import { InvalidDocPathError, resolveDocPathUnderContent } from "./path-utils.js";
import type { DocumentTreeEntry } from "../types/shared.js";

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

export interface SearchTextMatch {
  doc_path: string;
  heading_path: string[];
  match_context: string;
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
  docPath: string;
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

function flattenDocumentPaths(entries: DocumentTreeEntry[]): string[] {
  const docPaths: string[] = [];
  const walk = (nodes: DocumentTreeEntry[]): void => {
    for (const node of nodes) {
      if (node.type === "file") {
        docPaths.push(node.path);
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
): Promise<string[]> {
  const contentRoot = getContentRoot();
  try {
    const absoluteDocPath = resolveDocPathUnderContent(contentRoot, normalizedDocPath);
    await access(absoluteDocPath);
  } catch (error) {
    if (
      error instanceof InvalidDocPathError ||
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    ) {
      throw new DiscoveryNotFoundError();
    }
    throw error;
  }

  const readable = await checkDocPermission(writer, normalizedDocPath, "read");
  if (!readable) {
    throw new DiscoveryNotFoundError();
  }
  return [normalizedDocPath];
}

async function resolveFolderScope(
  writer: AuthenticatedWriter | null,
  normalizedFolderPath: string,
): Promise<string[]> {
  let tree: DocumentTreeEntry[];
  try {
    tree = await readDocumentsTree(normalizedFolderPath, true);
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
): Promise<{ scope: ParsedScope; docPaths: string[] }> {
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

function deriveDocPathFromMatchedFile(contentRoot: string, absolutePath: string): string | null {
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
  return "/" + [...segments.slice(0, docIndex), docLeaf].join("/");
}

function collectRawMatchesFromRgJsonLine(
  line: string,
  results: RawRipgrepMatch[],
  maxResults: number,
): void {
  if (line.trim().length === 0) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  const event = parsed as {
    type?: string;
    data?: {
      path?: { text?: string };
      absolute_offset?: number;
      submatches?: Array<{ start?: number; end?: number }>;
    };
  };

  if (event.type !== "match") return;

  const absolutePath = event.data?.path?.text;
  const absoluteOffset = event.data?.absolute_offset;
  const submatches = event.data?.submatches;
  if (typeof absolutePath !== "string" || typeof absoluteOffset !== "number" || !Array.isArray(submatches)) {
    return;
  }

  for (const submatch of submatches) {
    if (typeof submatch.start !== "number" || typeof submatch.end !== "number") continue;
    results.push({
      absolutePath,
      startByte: absoluteOffset + submatch.start,
      endByte: absoluteOffset + submatch.end,
    });
    if (results.length >= maxResults) {
      return;
    }
  }
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        settleReject(new SearchTextExecutionError("ripgrep binary not found. Install ripgrep in the runtime image."));
        return;
      }
      settleReject(error as Error);
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

export async function listReadableDocuments(
  writer: AuthenticatedWriter | null,
  root: string | undefined,
): Promise<ListDocumentsRow[]> {
  const { docPaths } = await resolveScopedReadableDocuments(writer, root, "root");
  const layer = new ContentLayer(getContentRoot());

  const rows = await Promise.all(
    docPaths.map(async (docPath) => {
      try {
        const sections = await layer.getSectionDiscoveryList(docPath);
        return {
          doc_path: docPath,
          section_count: sections.length,
        };
      } catch (error) {
        if (error instanceof DocumentNotFoundError) {
          return null;
        }
        throw error;
      }
    }),
  );

  return rows.filter((row): row is ListDocumentsRow => row !== null);
}

export async function listReadableSections(
  writer: AuthenticatedWriter | null,
  pathScope: string | undefined,
): Promise<ListSectionsRow[]> {
  const { docPaths } = await resolveScopedReadableDocuments(writer, pathScope, "path");
  const layer = new ContentLayer(getContentRoot());
  const rows: ListSectionsRow[] = [];

  for (const docPath of docPaths) {
    let sections;
    try {
      sections = await layer.getSectionDiscoveryList(docPath);
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        continue;
      }
      throw error;
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

  return rows;
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

  let absoluteSearchScope = contentRoot;
  if (scope.kind === "folder") {
    absoluteSearchScope = path.join(contentRoot, scope.normalized_path.replace(/^\/+/, ""));
  } else if (scope.kind === "document") {
    absoluteSearchScope = resolveDocPathUnderContent(contentRoot, scope.normalized_path) + ".sections";
    try {
      await access(absoluteSearchScope);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return {
          matches: [],
          timings: {
            total_ms: roundMs(performance.now() - totalStart),
            scope_and_acl_ms: roundMs(scopeAndAclMs),
            ripgrep_ms: 0,
            match_mapping_ms: 0,
            context_read_ms: 0,
          },
        };
      }
      throw error;
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
  if (rawMatches.length === 0) {
    return {
      matches: [],
      timings: {
        total_ms: roundMs(performance.now() - totalStart),
        scope_and_acl_ms: roundMs(scopeAndAclMs),
        ripgrep_ms: roundMs(ripgrepMs),
        match_mapping_ms: 0,
        context_read_ms: 0,
      },
    };
  }

  const matchMappingStart = performance.now();
  const searchableFiles = new Map<string, SearchableSectionFile>();
  const layer = new ContentLayer(contentRoot);

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
      if (error instanceof DocumentNotFoundError) {
        continue;
      }
      if (error instanceof SectionNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  const matchMappingMs = performance.now() - matchMappingStart;

  const fileCache = new Map<string, Buffer>();
  const matches: SearchTextMatch[] = [];
  let contextReadMs = 0;
  for (const match of rawMatches) {
    if (matches.length >= normalized.max_results) break;

    const fileMeta = searchableFiles.get(`${match.absolutePath}:${match.startByte}:${match.endByte}`);
    if (!fileMeta) continue;

    let fileContent = fileCache.get(fileMeta.absolutePath);
    if (!fileContent) {
      const contextReadStart = performance.now();
      try {
        fileContent = await readFile(fileMeta.absolutePath);
      } catch (error) {
        contextReadMs += performance.now() - contextReadStart;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      contextReadMs += performance.now() - contextReadStart;
      fileCache.set(fileMeta.absolutePath, fileContent);
    }

    matches.push({
      doc_path: fileMeta.docPath,
      heading_path: [...fileMeta.headingPath],
      match_context: extractContext(fileContent, match.startByte, match.endByte, normalized.context_bytes),
      match_offset_bytes: match.startByte,
    });
  }

  return {
    matches,
    timings: {
      total_ms: roundMs(performance.now() - totalStart),
      scope_and_acl_ms: roundMs(scopeAndAclMs),
      ripgrep_ms: roundMs(ripgrepMs),
      match_mapping_ms: roundMs(matchMappingMs),
      context_read_ms: roundMs(contextReadMs),
    },
  };
}
