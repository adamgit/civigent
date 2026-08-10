/**
 * The search results card list — one card per hit, always the COMPLETE list it
 * is handed. Truncation, if it ever happens, belongs to the backend's
 * `max_results` and is visible in the match count; this component never drops a
 * row for layout convenience.
 *
 * Each card carries its hit kind loudly: a large kind icon, a kind-colored left
 * accent, and a kind badge, so a folder-name hit is never mistaken for body text.
 */
import { Link } from "react-router-dom";
import type { SearchTextMatch } from "../../services/api-client";
import { docHref, folderHref } from "../../app/docs-location";
import { DocPath, FolderPath } from "../../types/shared";
import { SEARCH_HIT_KIND_TOKENS } from "./search-hit-kinds";

export function headingPathLabel(headingPath: string[]): string {
  if (headingPath.length === 0) return "(before first heading)";
  return headingPath.join(" > ");
}

export function documentTitleFromPath(docPath: string): string {
  const filename = docPath.split("/").filter(Boolean).pop() ?? docPath;
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildHighlightRegex(
  pattern: string,
  syntax: "literal" | "regexp",
  caseSensitive: boolean,
): RegExp | null {
  if (!pattern) return null;
  const source = syntax === "literal" ? escapeRegExp(pattern) : pattern;
  try {
    return new RegExp(source, caseSensitive ? "g" : "gi");
  } catch {
    // Highlighting is decoration: a pattern the browser's engine rejects but
    // ripgrep accepted still has real results to show, unhighlighted. The
    // search itself already surfaces pattern errors from the server.
    return null;
  }
}

export function HighlightedContext({
  text,
  highlightRegex,
}: {
  text: string;
  highlightRegex: RegExp | null;
}) {
  if (!highlightRegex) return <>{text}</>;

  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let cursor = 0;
  const regex = new RegExp(highlightRegex.source, highlightRegex.flags);

  while (true) {
    const match = regex.exec(text);
    if (!match) break;

    const matchedText = match[0] ?? "";
    const start = match.index;
    const end = start + matchedText.length;

    if (matchedText.length === 0) {
      regex.lastIndex += 1;
      continue;
    }

    if (start > cursor) {
      parts.push({ text: text.slice(cursor, start), highlighted: false });
    }
    parts.push({ text: matchedText, highlighted: true });
    cursor = end;
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false });
  }

  if (parts.length === 0) return <>{text}</>;

  return (
    <>
      {parts.map((part, index) =>
        part.highlighted ? (
          <mark
            key={`${index}:${part.text}`}
            style={{
              background: "var(--color-status-yellow-light)",
              color: "var(--color-status-yellow)",
              padding: "0 1px",
              borderRadius: 2,
            }}
          >
            {part.text}
          </mark>
        ) : (
          <span key={`${index}:${part.text}`}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function SearchHitCards({
  matches,
  highlightRegex,
}: {
  matches: readonly SearchTextMatch[];
  highlightRegex: RegExp | null;
}) {
  return (
    <>
      {matches.map((match, index) => {
        const tokens = SEARCH_HIT_KIND_TOKENS[match.kind];
        // A `path_segment` hit's path is a FOLDER, so it has no document route,
        // no section, and no "Open document" — it opens the folder browser.
        const isFolderHit = match.kind === "path_segment";
        const hitFolderPath = isFolderHit ? FolderPath.tryParse(match.doc_path) : null;
        const targetUrl = isFolderHit
          ? hitFolderPath && folderHref(hitFolderPath)
          : docHref(DocPath.parse(match.doc_path));
        const sectionLabel = headingPathLabel(match.heading_path);
        const documentTitle = documentTitleFromPath(match.doc_path);
        return (
          <div
            key={`${match.kind}:${match.doc_path}:${match.heading_path.join(">>")}:${match.match_offset_bytes}:${index}`}
            className="mb-3.5 overflow-hidden rounded-[10px] border border-footer-border border-l-[3px] bg-canvas-bg transition-all duration-150 hover:border-accent-border hover:shadow-[0_4px_16px_rgba(45,122,138,0.08)]"
            style={{ borderLeftColor: tokens.foreground }}
          >
            <div className="bg-gradient-to-br from-sidebar-bg/60 to-page-bg px-3.5 py-2.5 flex items-center gap-2.5 border-b border-footer-border/70">
              <div
                className="shrink-0 flex items-center justify-center rounded-lg border"
                style={{
                  width: 34,
                  height: 34,
                  color: tokens.foreground,
                  background: tokens.background,
                  borderColor: tokens.border,
                }}
                title={tokens.description}
              >
                <tokens.Icon size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="text-[15px] text-text-primary font-medium leading-tight"
                  style={{ fontFamily: "var(--font-body)" }}
                >
                  {/* The name IS the match for filename and folder hits, so it
                      carries the highlight; for body/heading hits the title is
                      just context for where the match lives. */}
                  {isFolderHit || match.kind === "filename" ? (
                    <HighlightedContext text={documentTitle} highlightRegex={highlightRegex} />
                  ) : (
                    documentTitle
                  )}
                </div>
                <div className="font-mono text-[11px] text-text-muted mt-0.5 break-all">
                  {match.doc_path}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <span
                  className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border whitespace-nowrap"
                  style={{
                    color: tokens.foreground,
                    background: tokens.background,
                    borderColor: tokens.border,
                  }}
                >
                  {tokens.shortLabel}
                </span>
                <span className="font-mono text-[10px] text-text-muted whitespace-nowrap">
                  offset {match.match_offset_bytes}
                </span>
              </div>
            </div>

            <div className="bg-canvas-bg px-3.5 py-2.5">
              {match.kind === "body" ? (
                <p
                  className="text-sm text-text-secondary leading-relaxed line-clamp-3 m-0"
                  style={{ fontFamily: "var(--font-body)" }}
                >
                  <HighlightedContext text={match.match_context} highlightRegex={highlightRegex} />
                </p>
              ) : (
                // For the locator kinds `match_context` IS the matched name —
                // the heading, the filename stem, the folder prefix — so it gets
                // stated plainly rather than dressed as a body excerpt.
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[11px] uppercase tracking-wide shrink-0" style={{ color: tokens.foreground }}>
                    {tokens.label}
                  </span>
                  <span
                    className={`text-sm text-text-primary font-medium min-w-0 ${isFolderHit ? "font-mono break-all" : "truncate"}`}
                    style={isFolderHit ? undefined : { fontFamily: "var(--font-body)" }}
                  >
                    <HighlightedContext text={match.match_context} highlightRegex={highlightRegex} />
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 px-3.5 py-1.5 bg-canvas-bg border-t border-footer-border text-xs">
              {targetUrl ? (
                <Link to={targetUrl} className="text-accent font-medium no-underline hover:underline">
                  {isFolderHit ? "Open folder →" : "Open document →"}
                </Link>
              ) : (
                <span className="text-text-faint font-medium">{match.doc_path}</span>
              )}
              {/* Only body and heading hits belong to a section; a filename or
                  folder hit has no section, and an empty heading path there
                  would read as the misleading "(before first heading)". */}
              {match.kind === "body" || match.kind === "heading" ? (
                <span className="font-semibold text-[12px] text-accent-text bg-canvas-bg/70 px-2 py-0.5 rounded border border-accent-border/60 ml-auto">
                  {sectionLabel}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
}
