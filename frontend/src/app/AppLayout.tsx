import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { apiClient, SystemStartingError, setUnauthorizedHandler, setSystemStartingHandler, setWriterId } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import { connectSystemEvents, type FatalReport } from "../services/system-events-client";
import { DocumentsTreeNav } from "../components/DocumentsTreeNav";
import { MirrorPanel } from "../components/MirrorPanel";
import { SystemFatalScreen } from "../components/SystemFatalScreen";
import { rememberRecentDoc } from "../services/recent-docs";
import type { DocumentTreeEntry, AuthUser, CatalogChangedEvent } from "../types/shared.js";
import { stripLeadingSlashForRoute } from "./docsRouteUtils";

const DOC_BADGES_STORAGE_KEY = "ks_doc_badges";
const TREE_ROW_FLASH_DURATION_MS = 2800;
const BUILD_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type TreeRowFlashKind = "human" | "agent";

interface TreeRowFlashEntry {
  kind: TreeRowFlashKind;
  expiresAt: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatBuildDate(raw: string): { shortLabel: string; longLabel: string } {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { shortLabel: raw, longLabel: raw };
  }

  const day = pad2(date.getUTCDate());
  const month = BUILD_MONTHS[date.getUTCMonth()];
  const year = pad2(date.getUTCFullYear() % 100);
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());

  return {
    shortLabel: `${day}/${month}`,
    longLabel: `${day} ${month} ${year} - ${hours}:${minutes}`,
  };
}

function toCanonicalDocPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function readBadgeDocPaths(): Set<string> {
  try {
    const raw = localStorage.getItem(DOC_BADGES_STORAGE_KEY);
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return new Set(
      parsed
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .map((entry) => toCanonicalDocPath(entry)),
    );
  } catch {
    return new Set<string>();
  }
}

function writeBadgeDocPaths(paths: Set<string>): void {
  try {
    localStorage.setItem(DOC_BADGES_STORAGE_KEY, JSON.stringify(Array.from(paths)));
  } catch {
    // Ignore storage write failures in constrained environments.
  }
}

function parseRouteDocPath(pathname: string): string | null {
  if (!pathname.startsWith("/docs/")) {
    return null;
  }
  const encodedPath = pathname.slice("/docs/".length);
  if (!encodedPath) {
    return null;
  }
  try {
    return toCanonicalDocPath(decodeURIComponent(encodedPath));
  } catch {
    return toCanonicalDocPath(encodedPath);
  }
}

interface ToastEntry {
  id: number;
  text: string;
  docPath: string;
}

export interface AppLayoutOutletContext {
  entries: DocumentTreeEntry[];
  treeLoading: boolean;
  treeSyncing: boolean;
  treeError: string | null;
  createDoc: (path: string) => Promise<void>;
  currentUser: AuthUser | null;
}

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const buildDate = useMemo(() => formatBuildDate(__BUILD_DATE__), []);
  const [entries, setEntries] = useState<DocumentTreeEntry[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [syncingTree, setSyncingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [newDocPath, setNewDocPath] = useState("");
  const [showNewDocForm, setShowNewDocForm] = useState(false);
  const [creatingDoc, setCreatingDoc] = useState(false);
  const [newDocError, setNewDocError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [docBadges, setDocBadges] = useState<Set<string>>(() => readBadgeDocPaths());
  const [treeRowFlashes, setTreeRowFlashes] = useState<Map<string, TreeRowFlashEntry>>(new Map());
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [systemStarting, setSystemStarting] = useState(false);
  const [fatalReport, setFatalReport] = useState<FatalReport | null>(null);
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === "visible");
  const [adminExpanded, setAdminExpanded] = useState(() => {
    try { return localStorage.getItem("ks_sidebar_admin_expanded") === "true"; } catch { return false; }
  });
  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);
  const focusedDocPath = useMemo(() => parseRouteDocPath(location.pathname), [location.pathname]);
  const focusedDocPathRef = useRef<string | null>(focusedDocPath);
  const windowFocusedRef = useRef(windowFocused);
  const documentVisibleRef = useRef(documentVisible);
  const nextToastIdRef = useRef(1);
  const previousFocusedDocPathRef = useRef<string | null>(null);

  const queueTreeRowFlashes = useCallback((docPaths: string[] | undefined, writerType?: string) => {
    if (!Array.isArray(docPaths) || docPaths.length === 0) {
      return;
    }
    const kind: TreeRowFlashKind = writerType === "agent" ? "agent" : "human";
    const expiresAt = Date.now() + TREE_ROW_FLASH_DURATION_MS;
    setTreeRowFlashes((previous) => {
      const next = new Map(previous);
      for (const docPath of docPaths) {
        const normalized = toCanonicalDocPath(docPath);
        next.set(normalized, { kind, expiresAt });
      }
      return next;
    });
  }, []);

  const loadTree = (options?: { background?: boolean }) => {
    if (options?.background) {
      setSyncingTree(true);
    } else {
      setLoadingTree(true);
      setTreeError(null);
    }
    return apiClient
      .getDocumentsTree()
      .then((response) => {
        setEntries(response.tree);
        setTreeError(null);
      })
      .catch((err) => {
        if (err instanceof SystemStartingError) return;
        if (!options?.background) {
          setTreeError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (options?.background) {
          setSyncingTree(false);
        } else {
          setLoadingTree(false);
        }
      });
  };

  const createDoc = useCallback(async (path: string): Promise<void> => {
    const docPath = path.endsWith(".md") ? path : `${path}.md`;
    await apiClient.createDocument(docPath);
    loadTree({ background: true }).catch(() => { /* non-fatal refresh */ });
    navigate(`/docs/${stripLeadingSlashForRoute(docPath)}`);
  }, [navigate]);

  const handleNewDocSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newDocPath.trim();
    if (!trimmed || creatingDoc) return;
    setCreatingDoc(true);
    setNewDocError(null);
    createDoc(trimmed)
      .then(() => {
        setShowNewDocForm(false);
        setNewDocPath("");
      })
      .catch((err) => {
        setNewDocError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setCreatingDoc(false);
      });
  };

  useEffect(() => {
    focusedDocPathRef.current = focusedDocPath;
  }, [focusedDocPath]);

  useEffect(() => {
    windowFocusedRef.current = windowFocused;
  }, [windowFocused]);

  useEffect(() => {
    documentVisibleRef.current = documentVisible;
  }, [documentVisible]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      if (location.pathname === "/login") {
        navigate("/login");
        return;
      }
      navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    });
    return () => {
      setUnauthorizedHandler(null);
    };
  }, [location.hash, location.pathname, location.search, navigate]);

  // Global handler: any API call that gets a 503 system_starting triggers startup UI
  useEffect(() => {
    setSystemStartingHandler(() => setSystemStarting(true));
    return () => setSystemStartingHandler(null);
  }, []);

  // SSE connection for backend lifecycle state (dev-only enhancement).
  // In dev, the supervisor serves SSE with starting/ready/fatal transitions.
  // In production, SSE is unavailable — the app works without it.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const disconnect = connectSystemEvents((state) => {
      if (state.state === "ready") {
        setSystemStarting(false);
        setFatalReport(null);
        setTreeError(null);
        loadTree().catch(() => {});
        apiClient.getSessionInfo()
          .then((session) => {
            if (session.authenticated && session.user?.id) {
              setWriterId(session.user.id);
              setCurrentUser(session.user);
            }
          })
          .catch(() => {});
      } else if (state.state === "fatal" && state.fatal) {
        setFatalReport(state.fatal);
      } else {
        setSystemStarting(true);
      }
    });
    return disconnect;
  }, []);

  // Initial data load — runs independently of SSE (which is dev-only).
  // If the server is still starting, the 503 handler sets systemStarting=true
  // and the recovery poll below takes over.
  useEffect(() => {
    loadTree().catch(() => {});
    apiClient.getSessionInfo()
      .then((session) => {
        if (session.authenticated && session.user?.id) {
          setWriterId(session.user.id);
          setCurrentUser(session.user);
        }
      })
      .catch(() => {});
  }, []);

  // Recovery poll: when systemStarting is set (by 503 handler or SSE),
  // poll until the server responds with a non-503 status, then recover.
  useEffect(() => {
    if (!systemStarting) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/documents/tree", {
          headers: { "X-Requested-With": "fetch" },
          credentials: "include",
        });
        if (res.status !== 503) {
          setSystemStarting(false);
          setFatalReport(null);
          setTreeError(null);
          loadTree().catch(() => {});
          apiClient.getSessionInfo()
            .then((session) => {
              if (session.authenticated && session.user?.id) {
                setWriterId(session.user.id);
                setCurrentUser(session.user);
              }
            })
            .catch(() => {});
        }
      } catch {
        // Network error — keep polling
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [systemStarting]);

  useEffect(() => {
    const handleFocus = () => setWindowFocused(true);
    const handleBlur = () => setWindowFocused(false);
    const handleVisibilityChange = () => setDocumentVisible(document.visibilityState === "visible");
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== DOC_BADGES_STORAGE_KEY) {
        return;
      }
      setDocBadges(readBadgeDocPaths());
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    writeBadgeDocPaths(docBadges);
  }, [docBadges]);

  useEffect(() => {
    if (!focusedDocPath) {
      return;
    }
    setDocBadges((previous) => {
      if (!previous.has(focusedDocPath)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(focusedDocPath);
      return next;
    });
  }, [focusedDocPath]);

  useEffect(() => {
    if (treeRowFlashes.size === 0) {
      return;
    }
    const now = Date.now();
    const nextExpiry = Math.min(...Array.from(treeRowFlashes.values(), (entry) => entry.expiresAt));
    const waitMs = Math.max(0, nextExpiry - now);
    const timer = window.setTimeout(() => {
      const cutoff = Date.now();
      setTreeRowFlashes((previous) => {
        const next = new Map(previous);
        for (const [docPath, entry] of next.entries()) {
          if (entry.expiresAt <= cutoff) {
            next.delete(docPath);
          }
        }
        return next;
      });
    }, waitMs + 10);
    return () => window.clearTimeout(timer);
  }, [treeRowFlashes]);

  useEffect(() => {
    wsClient.connect();
    let refreshTimer: number | null = null;
    const scheduleTreeRefresh = () => {
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        loadTree({ background: true }).catch(() => { /* non-fatal refresh */ });
      }, 180);
    };
    wsClient.onEvent((event) => {
      if (event.type === "dirty:changed") {
        return;
      }
      if (event.type === "catalog:changed" || event.type === "doc:renamed") {
        if (event.type === "catalog:changed") {
          const catalogChanged = event as CatalogChangedEvent;
          queueTreeRowFlashes(catalogChanged.added_doc_paths, catalogChanged.writer_type);
        }
        scheduleTreeRefresh();
        return;
      }
      if (event.type !== "content:committed") {
        return;
      }
      const committedDocPath = toCanonicalDocPath(event.doc_path);
      scheduleTreeRefresh();

      // Only show toast for agent commits
      if (event.writer_type !== "agent") {
        return;
      }
      const currentFocusedDocPath = focusedDocPathRef.current;
      const tabActive = windowFocusedRef.current && documentVisibleRef.current;
      if (currentFocusedDocPath === committedDocPath && tabActive) {
        return;
      }
      setDocBadges((previous) => {
        if (previous.has(committedDocPath)) {
          return previous;
        }
        const next = new Set(previous);
        next.add(committedDocPath);
        return next;
      });
      if (!tabActive) {
        return;
      }
      const toastId = nextToastIdRef.current;
      nextToastIdRef.current += 1;
      setToasts((previous) => [
        ...previous,
        {
          id: toastId,
          docPath: committedDocPath,
          text: `${event.writer_display_name} updated ${committedDocPath}`,
        },
      ]);
      window.setTimeout(() => {
        setToasts((previous) => previous.filter((entry) => entry.id !== toastId));
      }, 4500);
    });
    return () => {
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      wsClient.disconnect();
    };
  }, [wsClient]);

  const flashDocKinds = useMemo(
    () => new Map(Array.from(treeRowFlashes.entries(), ([docPath, entry]) => [docPath, entry.kind])),
    [treeRowFlashes],
  );

  // Send sessionDeparture when navigating away from a document
  useEffect(() => {
    const previous = previousFocusedDocPathRef.current;
    if (previous && previous !== focusedDocPath) {
      wsClient.sessionDeparture(previous);
    }
    previousFocusedDocPathRef.current = focusedDocPath;
  }, [focusedDocPath, wsClient]);

  // Focus/blur document tracking
  useEffect(() => {
    const shouldFocusDocument = windowFocused && documentVisible && focusedDocPath;
    if (shouldFocusDocument) {
      wsClient.focusDocument(shouldFocusDocument);
      return;
    }
    wsClient.blurDocument();
  }, [documentVisible, focusedDocPath, windowFocused, wsClient]);


  if (fatalReport) {
    return <SystemFatalScreen fatal={fatalReport} />;
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-[--spacing-sidebar-w] min-w-[--spacing-sidebar-w] bg-sidebar-bg border-r border-sidebar-border flex flex-col select-none">
        {/* Sidebar header */}
        <div className="px-3.5 pt-3.5 pb-2.5">
          <span className="text-xs font-semibold text-sidebar-heading uppercase tracking-wide">
            <a href="/">Civigent</a>
          </span>
        </div>

        {/* Sidebar tree */}
        <div className="flex-1 px-2 py-0.5 overflow-y-auto sidebar-scroll">
          <div className="flex items-center justify-between px-1.5 pt-2.5 pb-1.5">
            <Link to="/docs" className="flex items-center gap-1.5 text-[10.5px] font-semibold text-sidebar-heading uppercase tracking-wider hover:text-sidebar-text-hover transition-colors" style={{ textDecoration: "none" }}>
              <span className="opacity-50">&#128196;</span> All Documents
            </Link>
            {!loadingTree && (
              <button
                type="button"
                onClick={() => setShowNewDocForm((v) => !v)}
                className="text-[15px] text-sidebar-heading bg-transparent border-none cursor-pointer leading-none opacity-0 hover:opacity-100 transition-opacity"
              >
                +
              </button>
            )}
          </div>

          {!loadingTree && showNewDocForm && (
            <form onSubmit={handleNewDocSubmit} className="flex flex-col gap-1 mb-1.5 px-1.5">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={newDocPath}
                  onChange={(e) => setNewDocPath(e.target.value)}
                  placeholder="path/to/my-doc"
                  className="flex-1 min-w-0 text-xs font-[family-name:var(--font-ui)] bg-white/60 border border-sidebar-border rounded px-2 py-1 outline-none focus:border-accent-border"
                  autoFocus
                  disabled={creatingDoc}
                />
                <button
                  type="submit"
                  className="text-xs px-2 py-1 rounded bg-accent text-white border-none cursor-pointer"
                  disabled={creatingDoc}
                >
                  {creatingDoc ? "..." : "Go"}
                </button>
              </div>
              {newDocError ? (
                <p className="text-[11px] text-status-red m-0">{newDocError}</p>
              ) : null}
            </form>
          )}

          {loadingTree ? (
            <p className="text-xs text-sidebar-text px-1.5 py-2">Loading tree...</p>
          ) : null}
          {!loadingTree && syncingTree ? (
            <p className="text-[10px] text-text-faint px-1.5">Refreshing...</p>
          ) : null}
          {systemStarting ? (
            <p className="text-xs text-text-faint px-1.5 py-2">Waiting for system...</p>
          ) : treeError ? (
            <p className="text-xs text-status-red px-1.5 py-2">Tree unavailable: {treeError}</p>
          ) : null}
          {!loadingTree && !systemStarting && !treeError && entries.length === 0 ? (
            <p className="text-xs text-sidebar-text px-1.5 py-2">
              No documents yet.{" "}
              <button
                type="button"
                onClick={() => setShowNewDocForm(true)}
                className="bg-transparent border-none p-0 cursor-pointer text-inherit underline text-xs"
              >
                Create your first document.
              </button>
            </p>
          ) : null}
          {!loadingTree && !treeError && entries.length > 0 ? (
            <DocumentsTreeNav
              entries={entries}
              storageKey="ks_sidebar_tree_expanded"
              badgedDocPaths={docBadges}
              flashDocKinds={flashDocKinds}
              onDocumentOpen={rememberRecentDoc}
              onTreeRefresh={() => loadTree({ background: true })}
            />
          ) : null}
        </div>

        {/* Sidebar nav */}
        <nav className="px-2 pt-2.5 pb-3.5 border-t border-sidebar-border flex flex-col gap-px">
          <Link to="/setup" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
            <span className="text-xs w-4 text-center opacity-50">&#128268;</span> Connect Agent
          </Link>
          <Link to="/history" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
            <span className="text-xs w-4 text-center opacity-50">&#128336;</span> Audit Log
          </Link>
          <Link to="/agents-activity" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
            <span className="text-xs w-4 text-center opacity-50">&#129302;</span> Agents
          </Link>
          <div>
            <div className="flex items-center">
              <Link to="/admin" className="flex-1 flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                <span className="text-xs w-4 text-center opacity-50">&#9881;</span> Admin
              </Link>
              <button
                onClick={() => setAdminExpanded(p => { const next = !p; try { localStorage.setItem("ks_sidebar_admin_expanded", String(next)); } catch {} return next; })}
                className="px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all"
              >
                {adminExpanded ? "\u25B4" : "\u25BE"}
              </button>
            </div>
            {adminExpanded && (
              <div className="flex flex-col gap-px pl-4">
                <Link to="/proposals" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                  <span className="text-xs w-4 text-center opacity-50">&#128203;</span> Proposals
                </Link>
                <Link to="/session-inspector" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                  <span className="text-xs w-4 text-center opacity-50">&#128269;</span> Sessions
                </Link>
                <Link to="/coordination" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                  <span className="text-xs w-4 text-center opacity-50">&#128301;</span> Coordination
                </Link>
                <Link to="/admin/agents-auth" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                  <span className="text-xs w-4 text-center opacity-50">&#128273;</span> Agent Keys
                </Link>
                <Link to="/agent-simulator" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                  <span className="text-xs w-4 text-center opacity-50">&#129302;</span> Agent Sim
                </Link>
                <Link to="/imports" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                  <span className="text-xs w-4 text-center opacity-50">&#128229;</span> Imports
                </Link>
                <Link to="/admin/agent-mcp-logs" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                  <span className="text-xs w-4 text-center opacity-50">&#128202;</span> Agent Monitoring
                </Link>
                <Link to="/admin/snapshots" className="flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-xs text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover transition-all">
                  <span className="text-xs w-4 text-center opacity-50">&#128247;</span> Snapshots
                </Link>
              </div>
            )}
          </div>
        </nav>

        {/* Version footer */}
        <div className="px-3.5 py-2 border-t border-sidebar-border">
          <span
            className="text-[10px] text-sidebar-text/40"
            title={buildDate.longLabel}
          >
            v{__APP_VERSION__} &middot; {buildDate.shortLabel} &middot; {__BUILD_SHA__}
          </span>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Content */}
        <main className="flex-1 overflow-y-auto canvas-scroll">
          {/* Toasts */}
          {toasts.length > 0 ? (
            <div className="fixed top-4 right-4 z-20 grid gap-1.5">
              {toasts.map((toast) => (
                <div
                  key={toast.id}
                  role="status"
                  className="border border-agent-border rounded-lg px-3 py-2 bg-agent-light text-agent-text text-xs shadow-md"
                >
                  {toast.text}{" "}
                  <Link
                    to={`/docs/${stripLeadingSlashForRoute(toast.docPath)}`}
                    onClick={() => setToasts([])}
                    className="font-medium underline"
                  >
                    Open
                  </Link>
                </div>
              ))}
            </div>
          ) : null}
          {systemStarting ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-text-faint">
              <div className="flex gap-1.5">
                <span className="w-2 h-2 rounded-full bg-accent/60 animate-pulse" />
                <span className="w-2 h-2 rounded-full bg-accent/60 animate-pulse [animation-delay:300ms]" />
                <span className="w-2 h-2 rounded-full bg-accent/60 animate-pulse [animation-delay:600ms]" />
              </div>
              <p className="text-sm">The system is starting up. This page will refresh automatically.</p>
            </div>
          ) : (
            <Outlet context={{ entries, treeLoading: loadingTree, treeSyncing: syncingTree, treeError, createDoc, currentUser } satisfies AppLayoutOutletContext} />
          )}
        </main>
        <MirrorPanel />
      </div>
    </div>
  );
}
