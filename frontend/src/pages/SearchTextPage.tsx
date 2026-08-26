import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient, type SearchTextResponse } from "../services/api-client";
import { buildHighlightRegex } from "./search/SearchHitCards";
import { SearchHitInspector } from "./search/SearchHitInspector";
import { SearchMapChrome, type SearchMapMode } from "./search/SearchMapChrome";
import { SearchMapViewport } from "./search/SearchMapViewport";
import { buildSearchHitForest, hitsForSelection } from "./search/search-hit-forest";
import { SEARCH_MAX_RESULTS } from "./search/search-request-defaults";

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
  /**
   * Which map node the inspector is filtered to. `null` = no selection = show
   * every hit. Always cleared when a new response arrives: a path selected
   * against the previous query may not exist in the new forest at all.
   */
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mapMode, setMapMode] = useState<SearchMapMode>("folder");

  const pattern = searchParams.get("pattern") ?? "";
  const syntax = searchParams.get("syntax") === "regexp" ? "regexp" : "literal";
  const root = searchParams.get("root") ?? "/";
  const caseSensitive = searchParams.get("case_sensitive") ?? "false";
  // Both this fallback and the form's hidden input must carry SEARCH_MAX_RESULTS:
  // a direct URL navigation never posts the form, and a map built from a
  // 20-result slice would draw a confident picture of an arbitrary sample.
  const maxResults = searchParams.get("max_results") ?? SEARCH_MAX_RESULTS;
  const contextBytes = searchParams.get("context_bytes") ?? "100";
  const isCaseSensitive = caseSensitive === "true";

  useEffect(() => {
    if (!pattern.trim()) {
      setResponse(null);
      setError(null);
      setLoading(false);
      setSelectedPath(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    apiClient
      .searchText({
        pattern,
        syntax,
        root,
        caseSensitive: isCaseSensitive,
        maxResults,
        contextBytes,
        signal: controller.signal,
      })
      .then((data) => {
        setResponse(data);
        setSelectedPath(null);
        setLoading(false);
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setResponse(null);
        setSelectedPath(null);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => controller.abort();
  }, [contextBytes, isCaseSensitive, maxResults, pattern, root, syntax]);

  const prettyPayload = error
    ? { error: { message: error } }
    : response ?? { matches: [] };
  const highlightRegex = useMemo(
    () => buildHighlightRegex(pattern, syntax, isCaseSensitive),
    [pattern, syntax, isCaseSensitive],
  );
  const forest = useMemo(() => buildSearchHitForest(response?.matches ?? []), [response]);
  const selectedHits = useMemo(() => hitsForSelection(forest, selectedPath), [forest, selectedPath]);
  const hasResponsePayload = error !== null || response !== null;

  return (
    // The page owns its own scrollports (house pattern, same as DocumentPage):
    // the map column must stay put while results scroll, which it cannot do if
    // the whole page is one scrolling block.
    <section className="flex h-full min-h-0 flex-col overflow-hidden" style={{ padding: "0.5rem 0.75rem 0.75rem" }}>
      <SharedPageHeader title="Text Search" backTo="/" />

      <form
        action="/search-text"
        method="GET"
        className="shrink-0"
        style={{
          display: "grid",
          gap: "0.75rem",
          maxWidth: "56rem",
          marginBottom: "1rem",
        }}
      >
        <input type="hidden" name="root" value="/" />
        <input type="hidden" name="case_sensitive" value="false" />
        <input type="hidden" name="max_results" value={SEARCH_MAX_RESULTS} />
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
        <div className="flex min-h-0 flex-1 flex-col" style={{ gap: "0.75rem" }}>
          <p className="shrink-0" style={{ marginBottom: 0 }}>
            {response.matches.length} match{response.matches.length === 1 ? "" : "es"} for <strong>{pattern}</strong> ({syntax})
          </p>
          {response.failures && response.failures.length > 0 ? (
            <div
              role="alert"
              className="shrink-0"
              style={{
                fontSize: 13,
                color: "var(--color-danger, #b00020)",
                background: "var(--color-page-bg)",
                border: "1px solid var(--color-danger, #b00020)",
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              {response.failures.length} document{response.failures.length === 1 ? "" : "s"} failed to load and {response.failures.length === 1 ? "is" : "are"} not included in these results:
              <ul style={{ margin: "6px 0 0", paddingLeft: "1.25rem" }}>
                {response.failures.map((f, i) => (
                  <li key={`${f.doc_path}:${i}`}><code>{f.doc_path}</code> — {f.error}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div
            className="shrink-0"
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
            // Map left, results right. The row takes every pixel the header,
            // form, and meta strip did not, and each side owns its own
            // scrollport — so the map stays fixed in place while the cards
            // scroll past it.
            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
              <div className="flex h-[340px] min-h-0 shrink-0 flex-col gap-2 lg:h-auto lg:w-[380px]">
                <SearchMapChrome mode={mapMode} onModeChange={setMapMode} counts={forest.descendantCounts} />
                <div className="min-h-0 flex-1 overflow-auto canvas-scroll">
                  <SearchMapViewport
                    tree={forest}
                    mode={mapMode}
                    selectedPath={selectedPath}
                    onSelect={(path) => setSelectedPath(path)}
                  />
                </div>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto canvas-scroll pr-1">
                <SearchHitInspector
                  hits={selectedHits}
                  selectedPath={selectedPath}
                  onShowAll={() => setSelectedPath(null)}
                  highlightRegex={highlightRegex}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}

      {!loading && hasResponsePayload ? (
        // Kept, but collapsed: the raw payload is a debugging tool, and an
        // always-open JSON dump competes with the map and the cards for the
        // same attention.
        <details className="mt-2 shrink-0">
          <summary
            style={{
              cursor: "pointer",
              fontSize: 13,
              color: "var(--color-text-muted)",
              marginBottom: "0.5rem",
            }}
          >
            Raw response
          </summary>
          <div
            className="canvas-scroll"
            style={{
              border: "1px solid var(--color-footer-border)",
              borderRadius: 10,
              padding: "12px 14px",
              background: "var(--color-page-bg)",
              overflow: "auto",
              // The page no longer scrolls as a whole, so an expanded payload
              // scrolls inside its own box instead of pushing the layout.
              maxHeight: "40vh",
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
        </details>
      ) : null}
    </section>
  );
}
