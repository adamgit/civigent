import { type FormEvent, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import { SEARCH_MAX_RESULTS } from "./search/search-request-defaults";
import { useCurrentUser } from "../contexts/CurrentUserContext";
import { apiClient } from "../services/api-client";

export function HomePage() {
  const { createDoc, sidebarAutoHide, setSidebarAutoHide } = useOutletContext<AppLayoutOutletContext>();
  const currentUser = useCurrentUser();
  const [newDocPath, setNewDocPath] = useState("");
  const [creatingDoc, setCreatingDoc] = useState(false);
  const [newDocError, setNewDocError] = useState<string | null>(null);
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  const [degradedCount, setDegradedCount] = useState(0);
  const [degradedError, setDegradedError] = useState<string | null>(null);

  const [bootstrapAvailable, setBootstrapAvailable] = useState(false);
  const [bootstrapCode, setBootstrapCode] = useState("");
  const [bootstrapWorking, setBootstrapWorking] = useState(false);
  const [bootstrapMessage, setBootstrapMessage] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .listDegradedProposals()
      .then((res) => {
        if (!cancelled) {
          setDegradedCount(res.proposals.length + res.undecodable.length);
          setDegradedError(null);
        }
      })
      .catch((err) => { if (!cancelled) setDegradedError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getAuthMethods()
      .then((response) => {
        if (!cancelled) setBootstrapAvailable(!!response.bootstrap_available);
      })
      .catch(() => {
        /* non-fatal background fetch */
        if (!cancelled) setBootstrapAvailable(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleBootstrap = async () => {
    setBootstrapWorking(true);
    setBootstrapMessage(null);
    setBootstrapError(null);
    try {
      await apiClient.bootstrap(bootstrapCode);
      setBootstrapMessage("Admin role granted. You can now access admin features.");
      setBootstrapAvailable(false);
      setBootstrapCode("");
    } catch (err) {
      setBootstrapError(err instanceof Error ? err.message : String(err));
    } finally {
      setBootstrapWorking(false);
    }
  };

  const handleNewDocSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newDocPath.trim();
    if (!trimmed || creatingDoc) return;
    setCreatingDoc(true);
    setNewDocError(null);
    createDoc(trimmed)
      .then(() => setNewDocPath(""))
      .catch((err) => setNewDocError(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreatingDoc(false));
  };

  return (
    <div className="flex-1 overflow-auto canvas-scroll" style={{ fontFamily: "var(--font-ui)" }}>
      <div style={{ maxWidth: 740, margin: "0 auto", padding: "2.5rem 1.5rem 3rem" }}>

        {/* Degraded-proposal alert — quarantined proposals need an admin autofix */}
        {degradedCount > 0 && (
          <div
            role="alert"
            data-testid="degraded-proposals-alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-800"
          >
            <strong>{degradedCount}</strong> {degradedCount === 1 ? "proposal needs" : "proposals need"} admin review.{" "}
            <Link to="/proposals" className="font-medium underline">
              Review on Proposals &rarr;
            </Link>
          </div>
        )}
        {degradedError && (
          <p className="text-error" style={{ marginBottom: "1rem" }}>
            Could not check for degraded proposals: {degradedError}
          </p>
        )}

        {/* Bootstrap admin — after OIDC login, when no admin exists yet */}
        {bootstrapAvailable && currentUser && (
          <div
            role="region"
            aria-label="Bootstrap admin"
            data-testid="bootstrap-admin"
            style={{
              marginBottom: "1.75rem",
              background: "var(--color-sidebar-bg)",
              borderRadius: 12,
              padding: "14px 18px",
              border: "1px solid var(--color-footer-border)",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>
              Bootstrap admin
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 8 }}>
              No admin users exist. Enter the one-time bootstrap code from the server console to claim admin for your signed-in account.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={bootstrapCode}
                onChange={(e) => setBootstrapCode(e.target.value)}
                placeholder="Paste bootstrap code"
                className="input-field"
                style={{ flex: 1, height: 34 }}
                disabled={bootstrapWorking}
              />
              <button
                type="button"
                onClick={() => void handleBootstrap()}
                disabled={bootstrapWorking || !bootstrapCode.trim()}
                className="btn-primary"
                style={{ height: 34, opacity: bootstrapCode.trim() ? 1 : 0.5, whiteSpace: "nowrap" }}
              >
                Claim admin
              </button>
            </div>
            {bootstrapMessage && <p className="text-xs text-green-700" style={{ marginTop: 8 }}>{bootstrapMessage}</p>}
            {bootstrapError && <p data-testid="bootstrap-error" className="text-error" style={{ marginTop: 8 }}>{bootstrapError}</p>}
          </div>
        )}

        {/* Header */}
        <div style={{ marginBottom: "1.75rem" }}>
          
          <h1 style={{ fontFamily: "var(--font-body)", fontSize: 28, fontWeight: 500, lineHeight: 1.2, marginBottom: 4 }}>
            Docs for humans and agents
            &nbsp;&nbsp;
            <Link
            to="https://github.com/adamgit/civigent"
          >
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-accent)" }}>[Github]</span>
            </Link>
          </h1>
          <p style={{ fontSize: 14, color: "var(--color-text-secondary)" }}>
            Real-time collaborative editing with built-in AI agent coordination.
          </p>
        </div>

        {/* Workspace layout — Focus vs Browse; synced with the sidebar toggle */}
        <section
          aria-label="Workspace layout"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 0,
            marginBottom: "1.75rem",
            borderRadius: 12,
            border: "1px solid var(--color-footer-border)",
          }}
        >
          <button
            type="button"
            onClick={() => setSidebarAutoHide(true)}
            aria-pressed={sidebarAutoHide}
            style={{
              textAlign: "left",
              cursor: "pointer",
              border: "none",
              borderRight: "1px solid var(--color-footer-border)",
              borderRadius: "11px 0 0 11px",
              padding: "10px 14px",
              background: sidebarAutoHide ? "var(--color-accent-light)" : "var(--color-sidebar-bg)",
              color: sidebarAutoHide ? "var(--color-accent-text)" : "var(--color-text-secondary)",
              boxShadow: sidebarAutoHide ? "inset 0 0 0 2px var(--color-accent)" : "none",
              transition: "background 150ms ease, color 150ms ease, box-shadow 150ms ease",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3, color: sidebarAutoHide ? "var(--color-accent-text)" : "var(--color-text-primary)" }}>
              Focus mode
            </div>
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.4 }}>
              Hide the sidebar for more room to read and write. Hover the left edge of the window when you need the document tree again.
            </p>
          </button>
          <button
            type="button"
            onClick={() => setSidebarAutoHide(false)}
            aria-pressed={!sidebarAutoHide}
            style={{
              textAlign: "left",
              cursor: "pointer",
              border: "none",
              borderRadius: "0 11px 11px 0",
              padding: "10px 14px",
              background: !sidebarAutoHide ? "var(--color-agent2-light)" : "var(--color-sidebar-bg)",
              color: !sidebarAutoHide ? "#8a5520" : "var(--color-text-secondary)",
              boxShadow: !sidebarAutoHide ? "inset 0 0 0 2px var(--color-agent2)" : "none",
              transition: "background 150ms ease, color 150ms ease, box-shadow 150ms ease",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3, color: !sidebarAutoHide ? "#8a5520" : "var(--color-text-primary)" }}>
              Browse mode
            </div>
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.4 }}>
              Keep the sidebar open so you can jump between documents. Use this when you are exploring or moving around often.
            </p>
          </button>
        </section>

        {/* Create new doc */}
        <form
          onSubmit={handleNewDocSubmit}
          style={{
            maxWidth: "75%",
            margin: "1.75rem auto",
            background: "var(--color-sidebar-bg)",
            borderRadius: 12,
            padding: "14px 18px",
          }}
        >
          <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 8 }}>
            Create new document
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={newDocPath}
              onChange={(e) => setNewDocPath(e.target.value)}
              placeholder="e.g. roadmap.md or projects/brief.md"
              disabled={creatingDoc}
              className="input-field"
              style={{ flex: 1, height: 34 }}
            />
            <button
              type="submit"
              disabled={creatingDoc}
              className="btn-secondary"
              style={{ height: 34, cursor: creatingDoc ? "wait" : "pointer", whiteSpace: "nowrap" }}
            >
              {creatingDoc ? "Creating\u2026" : "Create"}
            </button>
          </div>
          {newDocError && <p className="text-error" style={{ marginTop: 6 }}>{newDocError}</p>}
        </form>

        {/* Manual search */}
        <form
          action="/search-text"
          method="GET"
          style={{
            marginBottom: "2rem",
            background: "var(--color-sidebar-bg)",
            borderRadius: 12,
            padding: "14px 18px",
          }}
        >
          <input type="hidden" name="root" value="/" />
          <input type="hidden" name="case_sensitive" value="false" />
          <input type="hidden" name="max_results" value={SEARCH_MAX_RESULTS} />
          <input type="hidden" name="context_bytes" value="100" />

          <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 8 }}>
            Manual text search
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              name="pattern"
              placeholder="Search /api/search"
              className="input-field"
              style={{ flex: 1, height: 34 }}
              required
            />
            <select
              name="syntax"
              defaultValue="literal"
              className="input-field"
              style={{ width: 120, height: 34 }}
            >
              <option value="literal">Plaintext</option>
              <option value="regexp">Regexp</option>
            </select>
            <button
              type="submit"
              className="btn-secondary"
              style={{ height: 34, whiteSpace: "nowrap" }}
            >
              Search
            </button>
          </div>
          <p style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-muted)" }}>
            Opens formatted search results inside the app.
          </p>
        </form>

        {/* Exported skills */}
        <section
          aria-label="Exported skills"
          style={{
            marginBottom: "2rem",
            background: "var(--color-sidebar-bg)",
            borderRadius: 12,
            padding: "16px 18px",
            border: "1px solid var(--color-footer-border)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-muted)", letterSpacing: "0.04em", marginBottom: 6 }}>
            New &middot; Claude Code skills
          </div>
          <h2 style={{ fontFamily: "var(--font-body)", fontSize: 18, fontWeight: 500, lineHeight: 1.25, marginBottom: 6 }}>
            Turn a folder into agent skills
          </h2>
          <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--color-text-secondary)" }}>
            Put markdown skills in the skills folder (default{" "}
            <code style={{ fontSize: 12 }}>/public_skills</code>
            ). Civigent exports them as a Claude Code plugin ZIP — install with{" "}
            <code style={{ fontSize: 12 }}>claude --plugin-url</code>
            {" "}and your agents can invoke those skills directly.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 13, fontWeight: 500 }}>
            <Link to="/skills" style={{ color: "var(--color-accent)", textDecoration: "none" }}>
              Skills &amp; launch command &rarr;
            </Link>
            <Link to="/docs/public_skills" style={{ color: "var(--color-accent)", textDecoration: "none" }}>
              Open skills folder &rarr;
            </Link>
          </div>
        </section>

        {/* Divider */}
        <hr style={{ border: "none", borderTop: "1px solid var(--color-footer-border)", margin: "0 0 1.5rem" }} />

        {/* Quick links — low priority; kept at the bottom */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <Link
            to="/setup"
            style={{
              background: "var(--color-sidebar-bg)",
              borderRadius: 8,
              padding: "10px 14px",
              textDecoration: "none",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 1 }}>For agents</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-accent)" }}>Connect an agent &rarr;</div>
          </Link>
          <div
            style={{ position: "relative" }}
            onMouseEnter={() => setShowHowItWorks(true)}
            onMouseLeave={() => setShowHowItWorks(false)}
            onFocus={() => setShowHowItWorks(true)}
            onBlur={() => setShowHowItWorks(false)}
          >
            <div
              style={{
                background: "var(--color-sidebar-bg)",
                borderRadius: 8,
                padding: "10px 14px",
              }}
            >
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 1 }}>How it works</div>
              <div style={{ display: "flex", gap: 14, fontSize: 13, fontWeight: 500 }}>
                <Link to="/features" style={{ color: "var(--color-accent)", textDecoration: "none" }}>
                  Features &rarr;
                </Link>
                <Link to="/help" style={{ color: "var(--color-accent)", textDecoration: "none" }}>
                  Help &rarr;
                </Link>
              </div>
            </div>
            {showHowItWorks && (
              <div
                style={{
                  position: "absolute",
                  bottom: "100%",
                  left: "50%",
                  transform: "translateX(-50%)",
                  paddingBottom: 8,
                  zIndex: 10,
                  width: 480,
                  maxWidth: "90vw",
                }}
                role="tooltip"
              >
                <div
                  style={{
                    background: "var(--color-page-bg)",
                    border: "1px solid var(--color-footer-border)",
                    borderRadius: 12,
                    padding: 12,
                    boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 10,
                  }}
                >
                  <div style={{ padding: "12px 14px", border: "1px solid var(--color-footer-border)", borderRadius: 8 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Live collaboration</p>
                    <p style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                      See other editors' cursors in real time. The section you're editing is locked to prevent conflicts.
                    </p>
                  </div>
                  <div style={{ padding: "12px 14px", border: "1px solid var(--color-footer-border)", borderRadius: 8 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Agent-safe by default</p>
                    <p style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                      AI agents propose changes that are evaluated before merging. Recently human-edited sections are automatically protected.
                    </p>
                  </div>
                  <div style={{ padding: "12px 14px", border: "1px solid var(--color-footer-border)", borderRadius: 8 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Proposals for deep work</p>
                    <p style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                      Reserve sections across documents for extended editing. Others see read-only content until you publish or cancel.
                    </p>
                  </div>
                  <div style={{ padding: "12px 14px", border: "1px solid var(--color-footer-border)", borderRadius: 8 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Nothing is lost</p>
                    <p style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.45 }}>
                      Every change is versioned and auto-saved. Close the tab, go idle, even survive a server restart &mdash; your work is safe.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
          <Link
            to="/history"
            style={{
              background: "var(--color-sidebar-bg)",
              borderRadius: 8,
              padding: "10px 14px",
              textDecoration: "none",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 1 }}>Compliance</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-accent)" }}>Audit Log &rarr;</div>
          </Link>
        </div>

      </div>
    </div>
  );
}
