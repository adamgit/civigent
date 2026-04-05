import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";

interface SearchTextMatch {
  doc_path: string;
  heading_path: string[];
  match_context: string;
  match_offset_bytes: number;
}

interface SearchTextResponse {
  matches: SearchTextMatch[];
  timings: {
    total_ms: number;
    scope_and_acl_ms: number;
    ripgrep_ms: number;
    match_mapping_ms: number;
    context_read_ms: number;
  };
}

function headingPathLabel(headingPath: string[]): string {
  if (headingPath.length === 0) return "(before first heading)";
  return headingPath.join(" > ");
}

function documentTitleFromPath(docPath: string): string {
  const filename = docPath.split("/").filter(Boolean).pop() ?? docPath;
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHighlightRegex(
  pattern: string,
  syntax: "literal" | "regexp",
  caseSensitive: boolean,
): RegExp | null {
  if (!pattern) return null;
  const source = syntax === "literal" ? escapeRegExp(pattern) : pattern;
  try {
    return new RegExp(source, caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

function HighlightedContext({
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

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span style={{ color: "var(--color-status-green)" }}>"{value}"</span>;
  }
  if (typeof value === "number") {
    return <span style={{ color: "var(--color-agent-text)" }}>{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span style={{ color: "var(--color-status-yellow)" }}>{String(value)}</span>;
  }
  if (value === null) {
    return <span style={{ color: "var(--color-text-muted)" }}>null</span>;
  }
  return <span style={{ color: "var(--color-text-primary)" }}>{String(value)}</span>;
}

function PrettyJsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || typeof value !== "object") {
    return <JsonPrimitive value={value} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>[]</span>;
    return (
      <div>
        <span>[</span>
        {value.map((item, index) => (
          <div key={index} style={{ paddingLeft: (depth + 1) * 16 }}>
            <PrettyJsonValue value={item} depth={depth + 1} />
            {index < value.length - 1 ? "," : ""}
          </div>
        ))}
        <div style={{ paddingLeft: depth * 16 }}><span>]</span></div>
      </div>
    );
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return <span>{"{}"}</span>;
  return (
    <div>
      <span>{"{"}</span>
      {entries.map(([key, entryValue], index) => (
        <div key={key} style={{ paddingLeft: (depth + 1) * 16 }}>
          <span style={{ color: "var(--color-accent-text)" }}>"{key}"</span>
          <span>: </span>
          <PrettyJsonValue value={entryValue} depth={depth + 1} />
          {index < entries.length - 1 ? "," : ""}
        </div>
      ))}
      <div style={{ paddingLeft: depth * 16 }}><span>{"}"}</span></div>
    </div>
  );
}

export function SearchTextPage() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<SearchTextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pattern = searchParams.get("pattern") ?? "";
  const syntax = searchParams.get("syntax") === "regexp" ? "regexp" : "literal";
  const root = searchParams.get("root") ?? "/";
  const caseSensitive = searchParams.get("case_sensitive") ?? "false";
  const maxResults = searchParams.get("max_results") ?? "20";
  const contextBytes = searchParams.get("context_bytes") ?? "100";
  const isCaseSensitive = caseSensitive === "true";

  const apiQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (pattern) params.set("pattern", pattern);
    params.set("syntax", syntax);
    params.set("root", root);
    params.set("case_sensitive", caseSensitive);
    params.set("max_results", maxResults);
    params.set("context_bytes", contextBytes);
    return params.toString();
  }, [pattern, syntax, root, caseSensitive, maxResults, contextBytes]);

  useEffect(() => {
    if (!pattern.trim()) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/search?${apiQuery}`, { signal: controller.signal })
      .then(async (res) => {
        const text = await res.text();
        let parsed: unknown = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }

        if (!res.ok) {
          const message =
            parsed && typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string"
              ? parsed.message
              : `${res.status} ${res.statusText}`;
          throw new Error(message);
        }

        return (parsed ?? { matches: [] }) as SearchTextResponse;
      })
      .then((data) => {
        setResponse(data);
        setLoading(false);
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setResponse(null);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => controller.abort();
  }, [apiQuery, pattern]);

  const prettyPayload = error
    ? { error: { message: error } }
    : response ?? { matches: [] };
  const highlightRegex = useMemo(
    () => buildHighlightRegex(pattern, syntax, isCaseSensitive),
    [pattern, syntax, isCaseSensitive],
  );
  const hasResponsePayload = error !== null || response !== null;

  return (
    <section style={{ padding: "0.5rem 0.75rem 1.5rem" }}>
      <SharedPageHeader title="Text Search" backTo="/" />

      <form
        action="/search-text"
        method="GET"
        style={{
          display: "grid",
          gap: "0.75rem",
          maxWidth: "56rem",
          marginBottom: "1.5rem",
        }}
      >
        <input type="hidden" name="root" value="/" />
        <input type="hidden" name="case_sensitive" value="false" />
        <input type="hidden" name="max_results" value="20" />
        <input type="hidden" name="context_bytes" value="100" />

        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            name="pattern"
            defaultValue={pattern}
            placeholder="Search text"
            className="input-field"
            style={{ flex: 1, height: 34 }}
            required
          />
          <select
            name="syntax"
            defaultValue={syntax}
            className="input-field"
            style={{ width: 120, height: 34 }}
          >
            <option value="literal">Plaintext</option>
            <option value="regexp">Regexp</option>
          </select>
          <button type="submit" className="btn-secondary" style={{ height: 34, whiteSpace: "nowrap" }}>
            Search
          </button>
        </div>
      </form>

      {!pattern.trim() ? <p style={{ color: "var(--color-text-muted)" }}>Enter a search pattern to run `/api/search`.</p> : null}
      {loading ? (
        <div
          style={{
            minHeight: 260,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "1.5rem",
          }}
        >
          <div
            style={{
              display: "grid",
              justifyItems: "center",
              gap: 12,
              padding: "20px 24px",
              borderRadius: 12,
              background: "var(--color-sidebar-bg)",
              border: "1px solid var(--color-footer-border)",
              minWidth: 280,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                border: "3px solid var(--color-accent-border)",
                borderTopColor: "var(--color-accent)",
                animation: "spin 1s linear infinite",
              }}
            />
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>
              Searching
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", textAlign: "center" }}>
              Running canonical text search and formatting results.
            </div>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-error">{error}</p> : null}

      {!loading && !error && response ? (
        <div style={{ display: "grid", gap: "0.75rem", marginBottom: "1.5rem" }}>
          <p style={{ marginBottom: 0 }}>
            {response.matches.length} match{response.matches.length === 1 ? "" : "es"} for <strong>{pattern}</strong> ({syntax})
          </p>
          <div
            style={{
              fontSize: 12,
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-mono)",
              background: "var(--color-page-bg)",
              border: "1px solid var(--color-footer-border)",
              borderRadius: 8,
              padding: "8px 10px",
            }}
          >
            total {response.timings.total_ms}ms | scope+acl {response.timings.scope_and_acl_ms}ms | ripgrep {response.timings.ripgrep_ms}ms | match-mapping {response.timings.match_mapping_ms}ms | context-read {response.timings.context_read_ms}ms
          </div>
          {response.matches.length === 0 ? (
            <p style={{ color: "var(--color-text-muted)" }}>No matches found.</p>
          ) : (
            response.matches.map((match, index) => {
              const docUrl = `/docs/${match.doc_path.replace(/^\/+/, "")}`;
              const sectionLabel = headingPathLabel(match.heading_path);
              const documentTitle = documentTitleFromPath(match.doc_path);
              return (
                <div
                  key={`${match.doc_path}:${match.heading_path.join(">>")}:${match.match_offset_bytes}:${index}`}
                  className="mb-3.5 overflow-hidden rounded-[10px] border border-footer-border border-l-[3px] border-l-sidebar-border bg-canvas-bg transition-all duration-150 hover:border-accent-border hover:border-l-accent hover:shadow-[0_4px_16px_rgba(45,122,138,0.08)]"
                >
                  <div className="bg-gradient-to-br from-sidebar-bg/60 to-page-bg px-3.5 py-2.5 flex items-center gap-2 border-b border-footer-border/70">
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-[15px] text-text-primary font-medium leading-tight"
                        style={{ fontFamily: "var(--font-body)" }}
                      >
                        {documentTitle}
                      </div>
                      <div className="font-mono text-[11px] text-text-muted mt-0.5 break-all">
                        {match.doc_path}
                      </div>
                    </div>
                    <div className="ml-auto flex items-center gap-2 shrink-0">
                      <span className="font-mono text-[10px] text-text-muted whitespace-nowrap">
                        offset {match.match_offset_bytes}
                      </span>
                    </div>
                  </div>

                  <div className="bg-canvas-bg px-3.5 py-2.5">
                    <p
                      className="text-sm text-text-secondary leading-relaxed line-clamp-3 m-0"
                      style={{ fontFamily: "var(--font-body)" }}
                    >
                      <HighlightedContext text={match.match_context} highlightRegex={highlightRegex} />
                    </p>
                  </div>

                  <div className="flex items-center gap-2 px-3.5 py-1.5 bg-canvas-bg border-t border-footer-border text-xs">
                    <Link
                      to={docUrl}
                      className="text-accent font-medium no-underline hover:underline"
                    >
                      Open document →
                    </Link>
                    <span className="font-semibold text-[12px] text-accent-text bg-canvas-bg/70 px-2 py-0.5 rounded border border-accent-border/60 ml-auto">
                      {sectionLabel}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : null}

      {!loading && hasResponsePayload ? (
        <>
          <h2>Raw Response</h2>
          <div
            style={{
              border: "1px solid var(--color-footer-border)",
              borderRadius: 10,
              padding: "12px 14px",
              background: "var(--color-page-bg)",
              overflowX: "auto",
            }}
          >
            <pre
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-primary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <PrettyJsonValue value={prettyPayload} />
            </pre>
          </div>
        </>
      ) : null}
    </section>
  );
}
