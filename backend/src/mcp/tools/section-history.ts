import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult, textToolResult } from "../tool-registry.js";
import { makeToolErrorResult, parseToolArgumentDocPath } from "../protocol.js";
import { authorizeDocRead, PermissionError } from "../../auth/authorized-read.js";
import { DocumentNotFoundError } from "../../storage/document-reader.js";
import { SectionNotFoundError } from "../../storage/section-reader.js";
import { HeadingNotFoundError } from "../../storage/heading-resolver.js";
import {
  listSectionHistoryVersions,
  readSectionHistoryVersion,
  SectionHistoryVersionNotFoundError,
} from "../../storage/section-history.js";
import { buildFragmentContent, fragmentFromBodyHolder } from "../../storage/section-formatting.js";

const listSectionHistoryHandler: ToolHandler = async (args, ctx) => {
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const rawLimit = args.limit;
  const rawOffset = args.offset;

  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath)) return makeToolErrorResult("Missing required parameter: heading_path (array of strings)");
  if (rawLimit !== undefined && !isNonNegativeInteger(rawLimit)) {
    return makeToolErrorResult("limit must be a non-negative integer");
  }
  if (rawOffset !== undefined && !isNonNegativeInteger(rawOffset)) {
    return makeToolErrorResult("offset must be a non-negative integer");
  }

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  let authorizedRead;
  try {
    authorizedRead = await authorizeDocRead(ctx.writer, docPath);
  } catch (error) {
    if (error instanceof PermissionError) {
      return makeToolErrorResult(`Permission denied: you do not have read access to "${docPath}".`);
    }
    throw error;
  }

  try {
    const { versions } = await listSectionHistoryVersions(
      authorizedRead,
      headingPath,
      rawLimit as number | undefined,
      rawOffset as number | undefined,
    );
    return jsonToolResult({ doc_path: docPath, heading_path: headingPath, versions });
  } catch (error) {
    if (
      error instanceof SectionNotFoundError ||
      error instanceof DocumentNotFoundError ||
      error instanceof HeadingNotFoundError
    ) {
      return makeToolErrorResult(`Section not found: ${headingPath.join(" > ")} in ${docPath}`);
    }
    throw error;
  }
};

const readSectionHistoryHandler: ToolHandler = async (args, ctx) => {
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const version = args.version as string | undefined;

  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath)) return makeToolErrorResult("Missing required parameter: heading_path (array of strings)");
  if (typeof version !== "string" || version.trim() === "") {
    return makeToolErrorResult("Missing required parameter: version (string from list_section_history)");
  }

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  let authorizedRead;
  try {
    authorizedRead = await authorizeDocRead(ctx.writer, docPath);
  } catch (error) {
    if (error instanceof PermissionError) {
      return makeToolErrorResult(`Permission denied: you do not have read access to "${docPath}".`);
    }
    throw error;
  }

  try {
    const stored = await readSectionHistoryVersion(authorizedRead, headingPath, version);

    if (ctx.writer.type === "agent" && ctx.emitEvent) {
      ctx.emitEvent({
        type: "agent:reading",
        actor_id: ctx.writer.id,
        actor_display_name: ctx.writer.displayName,
        doc_path: docPath,
        heading_paths: [headingPath],
      });
    }

    const markdown =
      headingPath.length === 0
        ? fragmentFromBodyHolder(stored.body)
        : buildFragmentContent(stored.body, stored.headingLevel, stored.heading);
    return textToolResult(markdown);
  } catch (error) {
    if (error instanceof SectionHistoryVersionNotFoundError) {
      return makeToolErrorResult(
        `Section history version not found: "${version}" is no longer part of this section's history in ${docPath}. ` +
          "Call list_section_history again to rediscover the current version handles.",
      );
    }
    if (
      error instanceof SectionNotFoundError ||
      error instanceof DocumentNotFoundError ||
      error instanceof HeadingNotFoundError
    ) {
      return makeToolErrorResult(`Section not found: ${headingPath.join(" > ")} in ${docPath}`);
    }
    throw error;
  }
};

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function registerSectionHistoryTools(registry: ToolRegistry): void {
  registry.register(
    "listSectionHistory",
    {
      name: "list_section_history",
      description:
        "List the stored versions of ONE published section, newest first. Each entry is an opaque `version` handle plus the timestamp of the commit that stored it — no SHA, author, or message. " +
        "The list is best-effort: it can shrink after structural edits to the document, which is expected behaviour, not data loss or corruption. " +
        "Handles are stable-or-dead: an existing handle keeps identifying the same stored body, and a handle that stops resolving means the lineage changed — call list_section_history again to rediscover current handles. " +
        "Use read_section_history with a version handle to read that stored body.",
      inputSchema: {
        type: "object",
        properties: {
          doc_path: { type: "string", description: "Document path (must end with .md)" },
          heading_path: { type: "array", items: { type: "string" }, description: "Heading path of the published section, as it reads today ([] is the before-first-heading section)" },
          limit: { type: "number", description: "Maximum number of versions to return (default 50)" },
          offset: { type: "number", description: "Number of versions to skip, newest first (default 0)" },
        },
        required: ["doc_path", "heading_path"],
      },
    },
    listSectionHistoryHandler,
  );

  registry.register(
    "readSectionHistory",
    {
      name: "read_section_history",
      description:
        "Read one stored historical version of a published section. The response IS the raw markdown of that stored body, rendered under the section's CURRENT heading — no JSON envelope and no historical structural metadata. " +
        "`version` comes from list_section_history. A dead handle (the lineage changed since you listed) returns not-found — call list_section_history again to rediscover current handles.",
      inputSchema: {
        type: "object",
        properties: {
          doc_path: { type: "string", description: "Document path (must end with .md)" },
          heading_path: { type: "array", items: { type: "string" }, description: "Heading path of the published section, as it reads today ([] is the before-first-heading section)" },
          version: { type: "string", description: "Opaque version handle from list_section_history" },
        },
        required: ["doc_path", "heading_path", "version"],
      },
    },
    readSectionHistoryHandler,
  );
}
