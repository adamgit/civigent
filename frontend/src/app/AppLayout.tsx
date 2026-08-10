import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { apiClient, SystemStartingError, setUnauthorizedHandler, setSystemStartingHandler, setWriterId, clearWriterId } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import { connectSystemEvents, type FatalReport } from "../services/system-events-client";
import { DocumentsTreeNav } from "../components/DocumentsTreeNav";
import { SidebarNavLinks } from "../components/SidebarNavLinks";
import { SystemFatalScreen } from "../components/SystemFatalScreen";
import { WsDiagnosticsConsole } from "../components/WsDiagnosticsConsole";
import { rememberRecentDoc } from "../services/recent-docs";
import { CurrentUserProvider } from "../contexts/CurrentUserContext";
import { SidebarIdentity } from "../components/SidebarIdentity";
import type { DocumentTreeEntry, AuthUser } from "../types/shared.js";
import { DocsLocation, docHref } from "./docs-location";
import { formatBuildDate, readSidebarAutoHide, writeSidebarAutoHide, classifyWsEvent } from "./app-layout-utils";
import { recordWsDiag } from "../services/ws-diagnostics";
import { computeBrowserTabTitle } from "./browser-tab-title";
import { DocPath } from "../types/shared";

function flattenTreeDocPaths(entries: DocumentTreeEntry[]): string[] {
  const out: string[] = [];
  const walk = (nodes: DocumentTreeEntry[]) => {
    for (const node of nodes) {
      if (node.type === "file") out.push(node.path);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(entries);
  return out;
}

const TREE_ROW_FLASH_DURATION_MS = 2800;

type TreeRowFlashKind = "human" | "agent";

interface TreeRowFlashEntry {
  kind: TreeRowFlashKind;
  expiresAt: number;
}

interface ToastEntry {
  id: number;
  text: string;
  docPath: DocPath;
}

/** Live document page → layout: tab-title edit flags for the focused file. */
export interface FocusedDocTabEditState {
  hasInFlightEdits: boolean;
  hasUnpublishedChanges: boolean;
}

export interface AppLayoutOutletContext {
  entries: DocumentTreeEntry[];
  treeLoading: boolean;
  treeSyncing: boolean;
  treeError: string | null;
  createDoc: (docPath: DocPath) => Promise<void>;
  refreshTree: () => Promise<void>;
  /** True when the sidebar auto-hides (Focus mode). */
  sidebarAutoHide: boolean;
  /** Set Focus (`true`) or Browse (`false`) mode; persists and syncs the header toggle. */
  setSidebarAutoHide: (autoHide: boolean) => void;
  /**
   * Report tab-title edit flags for a live document page. Scoped by `docPath` so
   * an unmounting page cannot clear the next page's report.
   */
  reportFocusedDocTabEditState: (docPath: string, state: FocusedDocTabEditState) => void;
  /** Clear flags previously reported for `docPath` (no-op if another doc is current). */
  clearFocusedDocTabEditState: (docPath: string) => void;
}

/** Left-rail panel glyph (VS Code / Notion style). Filled rail when pinned; empty when auto-hide. */
function SidebarPanelIcon({ autoHide }: { autoHide: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect
        x="1.75"
        y="2.25"
        width="14.5"
        height="13.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M7 2.25V15.75"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {autoHide ? null : (
        <rect x="2.5" y="3" width="4" height="12" rx="0.5" fill="currentColor" />
      )}
    </svg>
  );
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
  // Install label for tab titles (`KS_APP_NAME` or public URL). Seeded from the
  // browser origin so the first paint is already disambiguated before session loads.
  const [appName, setAppName] = useState(() => window.location.origin);
  const [focusedDocTabEdit, setFocusedDocTabEdit] = useState<
    (FocusedDocTabEditState & { docPath: string }) | null
  >(null);
  // Visible degraded state for an authoritative session check that genuinely
  // failed (500 / network / malformed) — distinct from a normal signed-out, so
  // the initial load never fails silently. Cleared on the next clean read.
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [docBadges, setDocBadges] = useState<Set<string>>(() => new Set());
  const [treeRowFlashes, setTreeRowFlashes] = useState<Map<string, TreeRowFlashEntry>>(new Map());
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [systemStarting, setSystemStarting] = useState(false);
  const [fatalReport, setFatalReport] = useState<FatalReport | null>(null);
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === "visible");
  const [wsDiagOpen, setWsDiagOpen] = useState(false);
  // One-click sidebar autohide (taskbar-style hover reveal). Persisted per tab
  // via sessionStorage, with localStorage as the seed for new tabs (last writer
  // wins). Header toggle and HomePage Focus/Browse share setSidebarAutoHide;
  // hover only reveals while already in autohide. hoverRevealArmed stays false
  // after collapse until the pointer leaves the shell — otherwise :hover on the
  // toggle immediately re-opens it.
  const [sidebarAutoHide, setSidebarAutoHideState] = useState(readSidebarAutoHide);
  const [hoverRevealArmed, setHoverRevealArmed] = useState(true);
  const setSidebarAutoHide = useCallback((autoHide: boolean) => {
    // Entering autohide: disarm hover reveal until pointer leaves the shell,
    // or the sidebar stays open under the click that collapsed it.
    setHoverRevealArmed(!autoHide);
    writeSidebarAutoHide(autoHide);
    setSidebarAutoHideState(autoHide);
  }, []);
  const [rootImporting, setRootImporting] = useState(false);
  const [rootImportError, setRootImportError] = useState<string | null>(null);
  const rootImportInputRef = useRef<HTMLInputElement>(null);
  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);
  const focusedDocPath = useMemo(() => {
    const loc = DocsLocation.fromPathname(location.pathname);
    return loc?.kind === "doc" ? loc.docPath : null;
  }, [location.pathname]);
  const reportFocusedDocTabEditState = useCallback((docPath: string, state: FocusedDocTabEditState) => {
    setFocusedDocTabEdit({ docPath, ...state });
  }, []);
  const clearFocusedDocTabEditState = useCallback((docPath: string) => {
    setFocusedDocTabEdit((prev) => (prev?.docPath === docPath ? null : prev));
  }, []);
  const fileEditFlags = useMemo(() => {
    if (!focusedDocPath || focusedDocTabEdit?.docPath !== focusedDocPath) {
      return { hasInFlightEdits: false, hasUnpublishedChanges: false };
    }
    return {
      hasInFlightEdits: focusedDocTabEdit.hasInFlightEdits,
      hasUnpublishedChanges: focusedDocTabEdit.hasUnpublishedChanges,
    };
  }, [focusedDocPath, focusedDocTabEdit]);
  useEffect(() => {
    document.title = computeBrowserTabTitle(location.pathname, appName, fileEditFlags);
  }, [location.pathname, appName, fileEditFlags]);
  const focusedDocPathRef = useRef<string | null>(focusedDocPath);
  const windowFocusedRef = useRef(windowFocused);
  const documentVisibleRef = useRef(documentVisible);
  const nextToastIdRef = useRef(1);

  const queueTreeRowFlashes = useCallback((docPaths: string[] | undefined, writerType?: string) => {
    if (!Array.isArray(docPaths) || docPaths.length === 0) {
      return;
    }
    const kind: TreeRowFlashKind = writerType === "agent" ? "agent" : "human";
    const expiresAt = Date.now() + TREE_ROW_FLASH_DURATION_MS;
    const flashedDocPaths = docPaths
      .map((docPath) => DocPath.coerce(docPath))
      .filter((docPath): docPath is DocPath => docPath != null);
    if (flashedDocPaths.length === 0) {
      return;
    }
    setTreeRowFlashes((previous) => {
      const next = new Map(previous);
      for (const docPath of flashedDocPaths) {
        next.set(docPath, { kind, expiresAt });
      }
      return next;
    });
  }, []);

  const previousTreePathsRef = useRef<string[]>([]);

  const loadTree = (options?: { background?: boolean }) => {
    if (options?.background) {
      setSyncingTree(true);
    } else {
      setLoadingTree(true);
      setTreeError(null);
    }
    const startedAt = performance.now();
    recordWsDiag({
      source: "tree-fetch",
      type: "getDocumentsTree",
      summary: options?.background ? "background refresh" : "initial/foreground load",
      payload: { background: !!options?.background },
    });
    return apiClient
      .getWorkspaceTree()
      .then((response) => {
        setEntries(response.tree);
        setTreeError(null);
        const nextPaths = flattenTreeDocPaths(response.tree);
        const previousPaths = previousTreePathsRef.current;
        const previousSet = new Set(previousPaths);
        const nextSet = new Set(nextPaths);
        const added = nextPaths.filter((p) => !previousSet.has(p));
        const removed = previousPaths.filter((p) => !nextSet.has(p));
        previousTreePathsRef.current = nextPaths;
        const durationMs = Math.round(performance.now() - startedAt);
        recordWsDiag({
          source: "tree-fetch-result",
          type: "getDocumentsTree",
          summary: `total=${nextPaths.length} +${added.length} -${removed.length} in ${durationMs}ms`,
          payload: { total: nextPaths.length, added, removed, durationMs },
        });
      })
      .catch((err) => {
        if (err instanceof SystemStartingError) return;
        if (!options?.background) {
          setTreeError(err instanceof Error ? err.message : String(err));
        }
        recordWsDiag({
          source: "tree-fetch-result",
          type: "getDocumentsTree",
          summary: `error: ${err instanceof Error ? err.message : String(err)}`,
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
      })
      .finally(() => {
        if (options?.background) {
          setSyncingTree(false);
        } else {
          setLoadingTree(false);
        }
      });
  };

  const createDoc = useCallback(async (docPath: DocPath): Promise<void> => {
    await apiClient.createDocument(docPath);
    loadTree({ background: true }).catch(() => { /* non-fatal refresh */ });
    navigate(docHref(docPath));
  }, [navigate]);

  const openCreateDocInFolder = useCallback((folderPath: string) => {
    const trimmedFolder = folderPath === "/" ? "" : folderPath.replace(/\/+$/, "");
    const prefill = trimmedFolder ? `${trimmedFolder}/` : "";
    setShowNewDocForm(true);
    setNewDocPath(prefill);
    setNewDocError(null);
  }, []);

  const handleNewDocSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newDocPath.trim();
    if (!trimmed || creatingDoc) return;
    const withMd = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
    const docPath = DocPath.tryParse(withMd.startsWith("/") ? withMd : `/${withMd}`);
    if (!docPath) {
      setNewDocError(`Invalid document path: ${JSON.stringify(withMd)}`);
      return;
    }
    setCreatingDoc(true);
    setNewDocError(null);
    createDoc(docPath)
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

  const handleRootExport = () => {
    window.location.href = `/api/export?path=${encodeURIComponent("/")}`;
  };

  const handleRootImportClick = () => {
    setRootImportError(null);
    if (rootImportInputRef.current) {
      rootImportInputRef.current.value = "";
      rootImportInputRef.current.click();
    }
  };

  const handleRootImportSelected = async () => {
    const input = rootImportInputRef.current;
    if (!input?.files || input.files.length === 0) return;
    setRootImporting(true);
    setRootImportError(null);
    try {
      const files = Array.from(input.files).filter((file) => file.name.toLowerCase().endsWith(".md"));
      if (files.length === 0) {
        throw new Error("No .md files selected.");
      }
      const staging = await apiClient.createImport();
      await apiClient.uploadImportFiles(staging.import_id, files);
      navigate(`/imports?expand=${encodeURIComponent(staging.import_id)}`);
    } catch (error) {
      setRootImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setRootImporting(false);
    }
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
        revalidateSession();
      } else if (state.state === "fatal" && state.fatal) {
        setFatalReport(state.fatal);
      } else {
        setSystemStarting(true);
      }
    });
    return disconnect;
  }, []);

  const revalidateSession = useCallback((options?: { initial?: boolean }) => {
    apiClient.getSessionInfo()
      .then((session) => {
        if (session.authenticated && session.user?.id) {
          setWriterId(session.user.id);
          setCurrentUser(session.user);
        } else {
          clearWriterId();
          setCurrentUser(null);
        }
        if (typeof session.app_name === "string" && session.app_name.trim()) {
          setAppName(session.app_name.trim());
        }
        // A clean read clears any prior degraded banner.
        setSessionError(null);
      })
      .catch((err) => {
        // 503 system_starting never reaches here — `requestJson` routes it to the
        // system-starting handler and returns a never-settling promise.
        if (err instanceof SystemStartingError) return;
        const message = err instanceof Error ? err.message : String(err);
        // NEVER discard the error: record it to the diagnostic ring buffer so the
        // failure is debuggable even though the UX fallback is non-fatal.
        recordWsDiag({
          source: "session-revalidate",
          type: "getSessionInfo",
          summary: `error: ${message}`,
          payload: { error: message, initial: !!options?.initial },
        });
        // Soft fallback in every case: identity falls back to signed-out.
        clearWriterId();
        setCurrentUser(null);
        // A 401 has already fired the unauthorized handler — that's a normal
        // not-signed-in, not a degraded server state, so no banner for it. A
        // genuine 500 / network / malformed failure on the AUTHORITATIVE initial
        // load surfaces a visible degraded state instead of failing silently;
        // high-frequency background refreshes keep the soft signed-out fallback.
        const unauthorized = err instanceof Error && /^401\b/.test(err.message);
        if (options?.initial && !unauthorized) {
          setSessionError(message);
        }
      });
  }, []);

  // Initial data load — runs independently of SSE (which is dev-only).
  // If the server is still starting, the 503 handler sets systemStarting=true
  // and the recovery poll below takes over.
  useEffect(() => {
    loadTree().catch(() => {});
    revalidateSession({ initial: true });
  }, [revalidateSession]);

  // Recovery poll: when systemStarting is set (by 503 handler or SSE),
  // poll until the server responds with a non-503 status, then recover.
  useEffect(() => {
    if (!systemStarting) return;
    const timer = setInterval(async () => {
      try {
        const ready = await apiClient.probeSystemReady();
        if (ready) {
          setSystemStarting(false);
          setFatalReport(null);
          setTreeError(null);
          loadTree().catch(() => {});
          revalidateSession();
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

  // Session revalidation on visibility change and window focus
  useEffect(() => {
    const handleVisibilityRevalidate = () => {
      if (document.visibilityState === "visible") revalidateSession();
    };
    const handleFocusRevalidate = () => revalidateSession();
    document.addEventListener("visibilitychange", handleVisibilityRevalidate);
    window.addEventListener("focus", handleFocusRevalidate);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityRevalidate);
      window.removeEventListener("focus", handleFocusRevalidate);
    };
  }, [revalidateSession]);

  // BroadcastChannel auth-sync for cross-tab coordination
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try { channel = new BroadcastChannel("ks_auth_sync"); } catch { /* unsupported env */ }
    if (!channel) return;

    const handleMessage = (event: MessageEvent) => {
      const msg = event.data;
      recordWsDiag({
        source: "broadcast-auth",
        type: typeof msg === "string" ? msg : "(non-string)",
        summary: "ks_auth_sync message received",
        payload: { msg },
      });
      if (msg === "login" || msg === "session_refreshed") {
        revalidateSession();
        if (msg === "login" && location.pathname === "/login") {
          navigate("/");
        }
      } else if (msg === "logout") {
        clearWriterId();
        setCurrentUser(null);
      }
    };
    channel.addEventListener("message", handleMessage);
    return () => {
      channel!.removeEventListener("message", handleMessage);
      channel!.close();
    };
  }, [revalidateSession, location.pathname, navigate]);

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
    let refreshTimer: number | null = null;
    const scheduleTreeRefresh = (reason: string) => {
      const coalesced = refreshTimer != null;
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
      }
      recordWsDiag({
        source: "tree-refresh-schedule",
        type: "scheduled",
        summary: coalesced ? `${reason} (coalesced)` : reason,
        payload: { reason, coalesced, debounceMs: 180 },
      });
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        loadTree({ background: true }).catch(() => { /* non-fatal refresh */ });
      }, 180);
    };
    wsClient.onEvent((event) => {
      // System-scoped fatal — applies in BOTH dev and prod builds and takes
      // precedence over everything else. Under KS_FATAL_ERRORS_MODE=report
      // the backend stays alive and broadcasts this over the app WS instead
      // of dying; late-joining tabs receive it via the hub's sticky replay.
      if (event.type === "system:fatal") {
        setFatalReport(event.report);
        return;
      }
      const tabActive = windowFocusedRef.current && documentVisibleRef.current;
      const result = classifyWsEvent(event, focusedDocPathRef.current, tabActive);
      const eventRecord = event as unknown as Record<string, unknown>;
      const eventType = typeof eventRecord.type === "string" ? eventRecord.type : "(untyped)";
      const docPath = typeof eventRecord.doc_path === "string" ? eventRecord.doc_path : undefined;
      const verdictKeys = Object.keys(result).filter((k) => (result as unknown as Record<string, unknown>)[k]);
      recordWsDiag({
        source: "ws-classification",
        type: eventType,
        summary: verdictKeys.length > 0 ? `-> ${verdictKeys.join(",")}` : "-> no-op",
        docPath,
        payload: { event, verdict: result, tabActive, focusedDocPath: focusedDocPathRef.current },
      });

      if (result.flashDocPaths) {
        queueTreeRowFlashes(result.flashDocPaths, result.flashWriterType);
      }
      if (result.refreshTree) {
        scheduleTreeRefresh(`ws:${eventType}`);
      }
      if (result.addBadge) {
        const badge = result.addBadge;
        setDocBadges((previous) => {
          if (previous.has(badge)) return previous;
          const next = new Set(previous);
          next.add(badge);
          return next;
        });
      }
      if (result.showToast) {
        const toastId = nextToastIdRef.current;
        nextToastIdRef.current += 1;
        const { text, docPath } = result.showToast;
        setToasts((previous) => [...previous, { id: toastId, docPath, text }]);
        window.setTimeout(() => {
          setToasts((previous) => previous.filter((entry) => entry.id !== toastId));
        }, 4500);
      }
    });
    wsClient.connect();
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
    <CurrentUserProvider currentUser={currentUser}>
    <div
      className="flex h-screen"
      data-sidebar-mode={sidebarAutoHide ? "autohide" : "expanded"}
      data-sidebar-hover-reveal={hoverRevealArmed ? "on" : "off"}
    >
      {/* Sidebar shell — reserves the in-flow width for the left column. In
          expanded mode this is the aside's own content width (capped 30vw); in
          autohide mode it collapses to the hotedge and the aside slides over. */}
      <div
        className="sidebar-shell"
        onMouseLeave={() => {
          if (sidebarAutoHide) setHoverRevealArmed(true);
        }}
      >
        {/* Thin left hit-strip; only visible/hoverable in autohide mode. */}
        <div className="sidebar-hotedge" aria-hidden="true" />
        {/* Sidebar — width now comes from the `.sidebar` CSS (max-content, 30vw
            cap); visuals stay on the Tailwind classes below. */}
        <aside className="sidebar bg-sidebar-bg border-r border-sidebar-border flex flex-col select-none overflow-visible min-w-0">
        {/* Sidebar header — brand left; layout toggle on the trailing edge with a text label. */}
        <div className="px-2.5 pt-3 pb-2.5 flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-sidebar-heading uppercase tracking-wide truncate min-w-0">
            <a href="/">Civigent</a>
          </span>
          <button
            type="button"
            onClick={(e) => {
              setSidebarAutoHide(!sidebarAutoHide);
              e.currentTarget.blur();
            }}
            aria-label={sidebarAutoHide ? "Pin sidebar open" : "Hide sidebar"}
            title={sidebarAutoHide ? "Pin sidebar open" : "Hide sidebar"}
            aria-pressed={sidebarAutoHide}
            className={`sidebar-toggle-btn ml-auto shrink-0 flex items-center gap-1.5 h-7 px-1.5 rounded cursor-pointer border-none transition-colors ${
              sidebarAutoHide
                ? "bg-white/55 text-sidebar-active-text"
                : "bg-transparent text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover"
            }`}
          >
            <SidebarPanelIcon autoHide={sidebarAutoHide} />
            <span className="text-[11px] font-medium whitespace-nowrap leading-none">
              {sidebarAutoHide ? "Pin sidebar" : "Hide sidebar"}
            </span>
          </button>
        </div>

        {/* Primary nav links (movable component) */}
        <SidebarNavLinks variant="primary" />

        {/* Sidebar tree */}
        <div className="flex-1 px-2 py-0.5 overflow-y-auto sidebar-scroll">
          <input
            ref={rootImportInputRef}
            type="file"
            accept=".md"
            multiple
            className="hidden"
            onChange={() => { void handleRootImportSelected(); }}
          />
          {/* All Documents + root export/import — text aligns with tree folder icons */}
          <div className="flex items-center gap-1 pt-2.5 pb-1.5">
            <Link
              to="/docs"
              className="min-w-0 flex-1 text-[10.5px] font-semibold text-sidebar-heading uppercase tracking-wider hover:text-sidebar-text-hover transition-colors truncate"
              style={{ textDecoration: "none" }}
            >
              All Documents
            </Link>
            <button
              type="button"
              title="Export all documents as ZIP"
              className="text-[11px] text-sidebar-text opacity-50 hover:opacity-100 bg-transparent border-none cursor-pointer p-0.5 leading-none transition-opacity"
              onClick={handleRootExport}
            >
              &#8595;
            </button>
            <button
              type="button"
              title="Import .md files to root"
              className="text-[11px] text-sidebar-text opacity-50 hover:opacity-100 bg-transparent border-none cursor-pointer p-0.5 leading-none transition-opacity disabled:opacity-30"
              onClick={handleRootImportClick}
              disabled={rootImporting}
            >
              &#8593;
            </button>
            {!loadingTree && (
              <button
                type="button"
                onClick={() => setShowNewDocForm((v) => !v)}
                className="text-[15px] text-sidebar-heading bg-transparent border-none cursor-pointer leading-none opacity-50 hover:opacity-100 transition-opacity"
                title="Create a new document"
                aria-label="Create a new document"
              >
                +
              </button>
            )}
          </div>
          {rootImportError ? (
            <p className="text-[11px] text-status-red m-0 mb-1 select-text">{rootImportError}</p>
          ) : null}
          {rootImporting ? (
            <p className="text-[10px] text-text-faint m-0 mb-1">Importing...</p>
          ) : null}

          {!loadingTree && showNewDocForm && (
            <form onSubmit={handleNewDocSubmit} className="flex flex-col gap-1 mb-1.5">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={newDocPath}
                  onChange={(e) => setNewDocPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    setShowNewDocForm(false);
                    setNewDocPath("");
                    setNewDocError(null);
                  }}
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
                <p className="text-[11px] text-status-red m-0 select-text">{newDocError}</p>
              ) : null}
            </form>
          )}

          {loadingTree ? (
            <p className="text-xs text-sidebar-text py-2">Loading tree...</p>
          ) : null}
          {!loadingTree && syncingTree ? (
            <p className="text-[10px] text-text-faint">Refreshing...</p>
          ) : null}
          {systemStarting ? (
            <p className="text-xs text-text-faint py-2">Waiting for system...</p>
          ) : treeError ? (
            <p className="text-xs text-status-red py-2 select-text">Tree unavailable: {treeError}</p>
          ) : null}
          {!loadingTree && !systemStarting && !treeError && entries.length === 0 ? (
            <p className="text-xs text-sidebar-text py-2">
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
              onCreateDocumentInFolder={openCreateDocInFolder}
            />
          ) : null}
        </div>

        {/* Footer nav links (movable component) */}
        <SidebarNavLinks
          variant="footer"
          onOpenWsDiagnostics={() => setWsDiagOpen(true)}
        />

        <SidebarIdentity />

        {/* Version footer */}
        <div className="px-3.5 py-2 border-t border-sidebar-border">
          <span
            className="text-[10px] text-sidebar-text/40"
            title={__BUILD_SHA__}
          >
            v{__APP_VERSION__} &middot; {buildDate.shortLabel}
          </span>
        </div>
        </aside>
      </div>

      {/* Main area — min-h-0 so flex children can own their own scrollports
          (e.g. DocumentPage canvas) instead of forcing this column to grow. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Content */}
        <main className="flex-1 min-h-0 overflow-y-auto canvas-scroll">
          {/* Authoritative session check failed (500 / network / malformed) — a
              visible degraded state so the initial load never fails silently. */}
          {sessionError ? (
            <div
              role="alert"
              data-testid="session-degraded"
              className="bg-red-50 border-b border-red-200 px-4 py-2 text-xs text-red-800"
            >
              Couldn&apos;t verify your session: {sessionError}. You may be signed out — retry by refreshing or refocusing the tab.
            </div>
          ) : null}
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
                    to={docHref(toast.docPath)}
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
            <Outlet
              context={{
                entries,
                treeLoading: loadingTree,
                treeSyncing: syncingTree,
                treeError,
                createDoc,
                refreshTree: () => loadTree({ background: true }),
                sidebarAutoHide,
                setSidebarAutoHide,
                reportFocusedDocTabEditState,
                clearFocusedDocTabEditState,
              } satisfies AppLayoutOutletContext}
            />
          )}
        </main>
        {/* Publish mirror intentionally hidden while the unpublished-changes UX is redesigned.
            Users are misusing the current flow, so we are disabling this entry point until
            there is a safer plan for publish behavior during active editing. */}
      </div>
      <WsDiagnosticsConsole open={wsDiagOpen} onClose={() => setWsDiagOpen(false)} />
    </div>
    </CurrentUserProvider>
  );
}
