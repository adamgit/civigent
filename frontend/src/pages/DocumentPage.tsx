import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Y from "yjs";
import { apiClient, resolveWriterId } from "../services/api-client";
import { CrdtProvider, type CrdtConnectionState, type StructureWillChangePayload } from "../services/crdt-provider";
import { getLastDocumentVisitAt, markDocumentVisitedNow } from "../services/document-visit-history";
import { rememberRecentDoc } from "../services/recent-docs";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import { MilkdownEditor, type MilkdownEditorHandle } from "../components/MilkdownEditor";
import { ProposalPanel } from "../components/ProposalPanel";
import { useCrossSectionCopy } from "../hooks/useCrossSectionCopy";
import { useViewingPresence, type ViewingUser } from "../hooks/useViewingPresence";
import type { Awareness } from "y-protocols/awareness";
import {
  sectionHeadingKey,
  sectionGlobalKey,
  type AgentReadingEvent,
  type ContentCommittedEvent,
  type DocRenamedEvent,
  type DocStructureChangedEvent,
  type DocStructureNode,
  type GetDocumentSectionsResponse,
  type PresenceDoneEvent,
  type PresenceEditingEvent,
  type ProposalPendingEvent,
  type ProposalWithdrawnEvent,
} from "../types/shared.js";

// ─── Helper types ────────────────────────────────────────────────

/**
 * Per-section persistence state. Each section has exactly one of these states.
 *
 * Transitions:
 *   clean ──[local Y.Doc update on focused section]──► dirty
 *   dirty ──[SESSION_FLUSH_STARTED received]──► pending
 *   pending ──[SESSION_FLUSHED payload includes this key]──► flushed
 *   flushed ──[local Y.Doc update on focused section]──► dirty
 *   clean ──[appears in SESSION_FLUSHED payload]──► flushed  (server knows more)
 *   any ──[content:committed includes this section]──► clean
 *
 * "deleting" is a terminal holding state for sections removed from the Y.Doc.
 */
type SectionPersistenceState = "clean" | "dirty" | "pending" | "flushed" | "deleting";

interface DeletionPlaceholder {
  fragmentKey: string;
  formerHeading: string;
  /** Index in section list where this placeholder should appear. */
  insertAfterIndex: number;
}

type DocumentSection = GetDocumentSectionsResponse["sections"][number];

interface RecentlyChangedSectionEntry {
  key: string;
  label: string;
  changedAtMs: number;
  changedByName: string;
}

interface AgentReadingIndicator {
  key: string;
  actorDisplayName: string;
  labels: string[];
  expiresAt: number;
}

interface PresenceIndicator {
  key: string;
  sectionKey: string;
  writerDisplayName: string;
}

interface PendingProposalIndicator {
  proposalId: string;
  sectionKey: string;
  writerDisplayName: string;
  intent: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

function normalizeDocPath(path: string): string {
  return path.trim().replace(/^\/+/, "");
}

function headingPathToLabel(path: string[]): string {
  return path.length === 0 ? "(document root)" : path.join(" > ");
}


/** Build a stable fragment key from a section filename.
 *  Root sections (empty heading at level 0) use "__root__". */
function fragmentKeyFromSectionFile(sectionFile: string, headingPath: string[]): string {
  const isRoot = headingPath.length === 0;
  if (isRoot) return "section::__root__";
  const stem = sectionFile.replace(/\.md$/, "");
  return "section::" + stem;
}

function formatRelativeAgeFromMs(changedAtMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - changedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getDocDisplayName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const filename = parts[parts.length - 1] || path;
  return filename.replace(/\.md$/, "");
}

/** Map human-involvement score to a border color class. */
function involvementBorderClass(score: number): string {
  if (score > 0.5) return "border-l-blue-600";
  if (score > 0.3) return "border-l-blue-300";
  return "border-l-slate-300";
}

/** Derive heading depth from heading_path (root = 1). */
function headingDepth(headingPath: string[]): number {
  return Math.max(1, headingPath.length);
}

/** Derive heading text from heading_path (last segment, or empty for root). */
function headingText(headingPath: string[]): string {
  if (headingPath.length === 0) return "";
  return headingPath[headingPath.length - 1];
}

/** Returns true if section at index i should have an editor mounted. */
function shouldMountEditor(i: number, focusedIndex: number | null): boolean {
  if (focusedIndex === null) return false;
  return Math.abs(i - focusedIndex) <= 1;
}

/** Recursively count all nodes in a DocStructureNode tree. */
function countStructureNodes(nodes: { children: unknown[] }[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (Array.isArray(node.children)) {
      count += countStructureNodes(node.children as { children: unknown[] }[]);
    }
  }
  return count;
}

/** Flatten a DocStructureNode tree into a list of heading entries for skeleton rendering. */
function flattenStructureTree(
  nodes: DocStructureNode[],
  parentPath: string[] = [],
): { headingPath: string[]; level: number }[] {
  const result: { headingPath: string[]; level: number }[] = [];
  for (const node of nodes) {
    const path = [...parentPath, node.heading];
    result.push({ headingPath: path, level: node.level });
    if (node.children?.length) {
      result.push(...flattenStructureTree(node.children, path));
    }
  }
  return result;
}

/** Rough per-section size estimate for display purposes. */
function estimateDocSize(sectionCount: number): string {
  const estimatedBytes = sectionCount * 500;
  if (estimatedBytes < 1024) return `~${estimatedBytes} B`;
  if (estimatedBytes < 1024 * 1024) return `~${Math.round(estimatedBytes / 1024)} KB`;
  return `~${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Don't show the loading indicator for fast loads — only reveal after this delay. */
const LOADING_REVEAL_DELAY_MS = 500;

/** How long the pastel highlight stays visible after content:committed. */
const HIGHLIGHT_DURATION_MS = 3000;

// ─── viewingPresence: small component to call the hook per-section ──

function ViewingPresenceDots({ awareness, sectionKey }: { awareness: Awareness | null; sectionKey: string }) {
  const viewers = useViewingPresence(awareness, sectionKey);
  if (viewers.length === 0) return null;
  return (
    <>
      {viewers.map((v, idx) => (
        <span
          key={`${v.name}-${idx}`}
          title={v.name}
          className="inline-block w-[7px] h-[7px] rounded-full border border-white/80"
          style={{ backgroundColor: v.color }}
        />
      ))}
    </>
  );
}

// ─── Component ───────────────────────────────────────────────────

interface DocumentPageProps {
  docPathOverride?: string | null;
}

export function DocumentPage({ docPathOverride }: DocumentPageProps = {}) {
  const params = useParams();
  const navigate = useNavigate();
  const decodedDocPath = useMemo(() => {
    if (typeof docPathOverride === "string" && docPathOverride.length > 0) {
      return docPathOverride;
    }
    const routeDocPath = params["*"];
    return routeDocPath ? decodeURIComponent(routeDocPath) : null;
  }, [docPathOverride, params]);

  // ── Section data ─────────────────────────────────────────
  const [sections, setSections] = useState<DocumentSection[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [structureTree, setStructureTree] = useState<DocStructureNode[] | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [loadDurationMs, setLoadDurationMs] = useState<number | null>(null);
  const loadStartedAtRef = useRef<number | null>(null);

  // ── Editing state (per-document) ────────────────────────
  const [focusedSectionIndex, setFocusedSectionIndex] = useState<number | null>(null);
  const [crdtProvider, setCrdtProvider] = useState<CrdtProvider | null>(null);
  const [crdtState, setCrdtState] = useState<CrdtConnectionState>("disconnected");
  const [crdtError, setCrdtError] = useState<string | null>(null);
  const [editingLoading, setEditingLoading] = useState(false);
  /** Per-section persistence state — single source of truth for dots and summary. */
  const [sectionPersistence, setSectionPersistence] = useState<Map<string, SectionPersistenceState>>(new Map());
  /** Deletion placeholders for sections removed but not yet confirmed by server. */
  const [deletionPlaceholders, setDeletionPlaceholders] = useState<DeletionPlaceholder[]>([]);
  /** Fragment keys currently being restructured — suppress rendering to avoid flash of empty content. */
  const [restructuringKeys, setRestructuringKeys] = useState<Set<string>>(new Set());
  const crdtProviderRef = useRef<CrdtProvider | null>(null);
  const editorRefs = useRef<Map<number, MilkdownEditorHandle>>(new Map());
  const pendingFocusRef = useRef<{ index: number; position: "start" | "end" } | null>(null);
  const pendingStructureRefocusRef = useRef<string[] | null>(null);
  const focusedSectionIndexRef = useRef<number | null>(null);
  const sectionsRef = useRef<DocumentSection[]>([]);

  // ── Proposal mode state ─────────────────────────────────
  const [proposalMode, setProposalMode] = useState(false);
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  /** Tracks section content edited during proposal mode (doc_path::heading_key → markdown). */
  const proposalSectionsRef = useRef<Map<string, { doc_path: string; heading_path: string[]; content: string }>>(new Map());
  const proposalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sectionsContainerRef = useRef<HTMLDivElement>(null);

  // ── Metadata state ───────────────────────────────────────
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [recentlyChangedSections, setRecentlyChangedSections] = useState<RecentlyChangedSectionEntry[]>([]);
  const [lastVisitSeed, setLastVisitSeed] = useState<{ docPath: string; since: string | null } | null>(null);

  // ── v3: Agent reading indicators ─────────────────────────
  const [agentReadingIndicators, setAgentReadingIndicators] = useState<AgentReadingIndicator[]>([]);

  // ── v3: Presence indicators ──────────────────────────────
  const [presenceIndicators, setPresenceIndicators] = useState<PresenceIndicator[]>([]);

  // ── v3: Pending proposal indicators ─────────────────────
  const [pendingProposalIndicators, setPendingProposalIndicators] = useState<PendingProposalIndicator[]>([]);

  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);

  // Derived
  const isEditing = focusedSectionIndex !== null;
  const focusedHeadingPath = focusedSectionIndex !== null && sections[focusedSectionIndex]
    ? sections[focusedSectionIndex].heading_path
    : null;

  // ── Highlight map: recently changed sections within HIGHLIGHT_DURATION_MS ──
  const recentlyChangedByLabel = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, RecentlyChangedSectionEntry>();
    for (const entry of recentlyChangedSections) {
      if (now - entry.changedAtMs < HIGHLIGHT_DURATION_MS) {
        map.set(entry.key, entry);
      }
    }
    return map;
  }, [recentlyChangedSections]);

  // ── Cross-section copy (clean markdown clipboard) ────────
  useCrossSectionCopy({
    containerRef: sectionsContainerRef,
    sections,
    editorRefs,
  });

  // Timer to force re-render when highlights expire (cleans up the pastel fade)
  useEffect(() => {
    if (recentlyChangedByLabel.size === 0) return;
    const timer = setTimeout(() => {
      // Prune expired entries to trigger re-render
      setRecentlyChangedSections((prev) =>
        prev.filter((e) => Date.now() - e.changedAtMs < HIGHLIGHT_DURATION_MS),
      );
    }, HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [recentlyChangedByLabel.size]);

  // ── Track state in refs for WS event handler (avoids stale closures) ──
  useEffect(() => {
    crdtProviderRef.current = crdtProvider;
  }, [crdtProvider]);
  useEffect(() => {
    focusedSectionIndexRef.current = focusedSectionIndex;
  }, [focusedSectionIndex]);
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  useEffect(() => {
    return () => {
      crdtProviderRef.current?.destroy();
      if (proposalSaveTimerRef.current) {
        clearTimeout(proposalSaveTimerRef.current);
      }
    };
  }, []);

  // ── Auto-expire agent reading indicators ─────────────────
  useEffect(() => {
    if (agentReadingIndicators.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setAgentReadingIndicators((prev) =>
        prev.filter((indicator) => indicator.expiresAt > now),
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [agentReadingIndicators.length]);

  // ── Recent doc tracking ──────────────────────────────────
  useEffect(() => {
    if (!decodedDocPath) return;
    rememberRecentDoc(decodedDocPath);
    const previousVisit = getLastDocumentVisitAt(decodedDocPath);
    setLastVisitSeed({ docPath: decodedDocPath, since: previousVisit });
    markDocumentVisitedNow(decodedDocPath);
  }, [decodedDocPath]);

  // ── Fetch lightweight structure metadata (skeleton only, no git) ──
  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    setStructureTree(null);
    apiClient.getDocumentStructure(decodedDocPath).then((resp) => {
      if (cancelled) return;
      setStructureTree(resp.structure);
    }).catch(() => { /* non-fatal background fetch */ });
    return () => { cancelled = true; };
  }, [decodedDocPath]);

  // ── Delayed loading reveal (suppress flicker on fast loads) ──
  useEffect(() => {
    if (!sectionsLoading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), LOADING_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sectionsLoading]);

  // ── Load sections ────────────────────────────────────────
  const loadSections = useCallback(async (docPath: string) => {
    loadStartedAtRef.current = Date.now();
    setLoadDurationMs(null);
    setSectionsLoading(true);
    setError(null);
    try {
      const sectionsResp = await apiClient.getDocumentSections(docPath);
      setSections(sectionsResp.sections);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loadStartedAtRef.current !== null) {
        setLoadDurationMs(Date.now() - loadStartedAtRef.current);
      }
      setSectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    loadSections(decodedDocPath).then(() => {
      if (cancelled) return;
    });
    return () => { cancelled = true; };
  }, [decodedDocPath, loadSections]);

  // ── Load changes-since (recently changed sections) ───────
  useEffect(() => {
    if (!decodedDocPath || !lastVisitSeed || lastVisitSeed.docPath !== decodedDocPath) return;
    let cancelled = false;
    apiClient.getChangesSince(decodedDocPath).then((response) => {
      if (cancelled) return;
      const changedSections = Array.isArray(response.changed_sections) ? response.changed_sections : [];
      setRecentlyChangedSections((previous) => {
        const next = new Map(previous.map((entry) => [entry.key, entry]));
        for (const change of changedSections) {
          const headingPath = Array.isArray(change.heading_path) ? change.heading_path : [];
          const label = headingPathToLabel(headingPath);
          next.set(label, { key: label, label, changedAtMs: Date.now(), changedByName: "Writer" });
        }
        return Array.from(next.values());
      });
    }).catch(() => { /* non-fatal background fetch */ });
    return () => { cancelled = true; };
  }, [decodedDocPath, lastVisitSeed]);

  // ── Stop editing helper ──────────────────────────────────
  const stopEditing = useCallback(() => {
    if (crdtProviderRef.current) {
      crdtProviderRef.current.destroy();
      setCrdtProvider(null);
      setCrdtState("disconnected");
    }
    setFocusedSectionIndex(null);
    setCrdtError(null);
    setSectionPersistence(new Map());
    setDeletionPlaceholders([]);
    setRestructuringKeys(new Set());
    editorRefs.current.clear();
    pendingFocusRef.current = null;
  }, []);

  // ── Proposal mode enter/exit ──────────────────────────────
  const enterProposalMode = useCallback(async (proposalId: string) => {
    // Disconnect CRDT (if connected) to exit collaborative editing
    if (crdtProviderRef.current) {
      crdtProviderRef.current.disconnect();
    }
    setProposalMode(true);
    setActiveProposalId(proposalId);
    setFocusedSectionIndex(null);
  }, []);

  const exitProposalMode = useCallback(() => {
    // Cancel any pending save
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
      proposalSaveTimerRef.current = null;
    }
    proposalSectionsRef.current.clear();
    setProposalMode(false);
    setActiveProposalId(null);
    // Reconnect CRDT if provider still exists
    if (crdtProviderRef.current) {
      crdtProviderRef.current.connect();
    }
    // Reload sections to get fresh canonical content
    if (decodedDocPath) {
      loadSections(decodedDocPath);
    }
  }, [decodedDocPath, loadSections]);

  /** Debounced save of proposal sections to backend (~2s after last edit). */
  const saveProposalSections = useCallback(() => {
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
    }
    proposalSaveTimerRef.current = setTimeout(async () => {
      proposalSaveTimerRef.current = null;
      const proposalId = activeProposalId;
      if (!proposalId) return;
      const sectionsList = [...proposalSectionsRef.current.values()];
      if (sectionsList.length === 0) return;
      try {
        await apiClient.updateProposal(proposalId, { sections: sectionsList });
      } catch (err) {
        setError(`Failed to save proposal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 2000);
  }, [activeProposalId]);

  /** Called when a section is edited in proposal mode. Auto-adds the section to the proposal. */
  const handleProposalSectionChange = useCallback((sectionIndex: number, markdown: string) => {
    const section = sections[sectionIndex];
    if (!section || !decodedDocPath) return;
    const key = sectionGlobalKey(decodedDocPath, section.heading_path);
    proposalSectionsRef.current.set(key, {
      doc_path: decodedDocPath,
      heading_path: section.heading_path,
      content: markdown,
    });
    saveProposalSections();
  }, [sections, decodedDocPath, saveProposalSections]);

  // ── WebSocket events ─────────────────────────────────────
  useEffect(() => {
    if (!decodedDocPath) return;
    wsClient.connect();
    wsClient.subscribe(decodedDocPath);
    wsClient.onEvent((event) => {
      // ── content:committed (v3 shape) ──
      if (event.type === "content:committed") {
        const committed = event as ContentCommittedEvent;
        if (normalizeDocPath(committed.doc_path) !== normalizeDocPath(decodedDocPath)) return;

        const changedSectionLabels = committed.sections.map((s) =>
          headingPathToLabel(s.heading_path),
        );

        const changedAtMs = Date.now();
        const changedByName = committed.writer_display_name || "Writer";
        setRecentlyChangedSections((previous) => {
          const next = new Map(previous.map((entry) => [entry.key, entry]));
          for (const label of changedSectionLabels) {
            next.set(label, { key: label, label, changedAtMs, changedByName });
          }
          return Array.from(next.values());
        });

        // Committed sections → clean in the persistence map
        const myWriterId = resolveWriterId();
        if (committed.writer_id === myWriterId) {
          setSectionPersistence((prev) => {
            const next = new Map(prev);
            for (const s of committed.sections) {
              // Look up section_file from current sections state
              const hpKey = sectionHeadingKey(s.heading_path);
              const match = sectionsRef.current.find((sec) => sectionHeadingKey(sec.heading_path) === hpKey);
              if (match) {
                const fk = fragmentKeyFromSectionFile(match.section_file, match.heading_path);
                next.delete(fk); // clean = absent from the map
              }
            }
            return next;
          });
        }

        // Clear pending proposal indicators for committed sections
        const committedSectionKeys = new Set(
          committed.sections.map((s) => sectionHeadingKey(s.heading_path)),
        );
        setPendingProposalIndicators((prev) =>
          prev.filter((ind) => !committedSectionKeys.has(ind.sectionKey)),
        );

        // Refresh sections to pick up new content
        if (!crdtProviderRef.current) {
          // No active CRDT session — full reload is safe
          loadSections(decodedDocPath);
        } else {
          // CRDT session active — selectively refresh non-CRDT-bound sections only.
          // Sections within ±1 of focusedSectionIndex are CRDT-bound; leave those untouched.
          apiClient.getDocumentSections(decodedDocPath).then((resp) => {
            const fi = focusedSectionIndexRef.current;
            setSections((prev) => {
              const next = [...prev];
              const freshByKey = new Map(
                resp.sections.map((s) => [sectionHeadingKey(s.heading_path), s]),
              );
              for (let i = 0; i < next.length; i++) {
                // Skip CRDT-bound sections (focused ±1)
                if (fi !== null && Math.abs(i - fi) <= 1) continue;
                const key = sectionHeadingKey(next[i].heading_path);
                const fresh = freshByKey.get(key);
                if (fresh) {
                  next[i] = fresh;
                }
              }
              // If section count changed (structure changed), use fresh list but
              // only when no CRDT editor is active to avoid disruption
              if (resp.sections.length !== prev.length && fi === null) {
                return resp.sections;
              }
              return next;
            });
          }).catch((err) => {
            console.error("Failed to refresh non-edited sections:", err);
          });
        }
        return;
      }

      // ── agent:reading (v3) ──
      if (event.type === "agent:reading") {
        const reading = event as AgentReadingEvent;
        if (normalizeDocPath(reading.doc_path) !== normalizeDocPath(decodedDocPath)) return;

        const labels = reading.heading_paths.map((hp) => headingPathToLabel(hp));
        const key = `${reading.actor_id}:${labels.join(",")}`;
        const expiresAt = Date.now() + 5000;

        setAgentReadingIndicators((prev) => {
          const next = new Map(prev.map((ind) => [ind.key, ind]));
          next.set(key, { key, actorDisplayName: reading.actor_display_name, labels, expiresAt });
          return Array.from(next.values());
        });
        return;
      }

      // ── presence:editing (v3) ──
      if (event.type === "presence:editing") {
        const presence = event as PresenceEditingEvent;
        if (normalizeDocPath(presence.doc_path) !== normalizeDocPath(decodedDocPath)) return;

        const sectionKey = sectionHeadingKey(presence.heading_path);
        const key = `${presence.writer_id}:${sectionKey}`;

        setPresenceIndicators((prev) => {
          const next = new Map(prev.map((ind) => [ind.key, ind]));
          next.set(key, { key, sectionKey, writerDisplayName: presence.writer_display_name });
          return Array.from(next.values());
        });
        return;
      }

      // ── presence:done (v3) ──
      if (event.type === "presence:done") {
        const done = event as PresenceDoneEvent;
        if (normalizeDocPath(done.doc_path) !== normalizeDocPath(decodedDocPath)) return;

        const sectionKey = sectionHeadingKey(done.heading_path);
        const key = `${done.writer_id}:${sectionKey}`;

        setPresenceIndicators((prev) => prev.filter((ind) => ind.key !== key));
        return;
      }

      // ── doc:renamed ──
      if (event.type === "doc:renamed") {
        const renamed = event as DocRenamedEvent;
        if (normalizeDocPath(renamed.old_path) === normalizeDocPath(decodedDocPath)) {
          navigate(`/documents/${encodeURIComponent(renamed.new_path)}`, { replace: true });
        }
        return;
      }

      // ── doc:structure-changed ──
      if (event.type === "doc:structure-changed") {
        const e = event as DocStructureChangedEvent;
        if (normalizeDocPath(e.doc_path) !== normalizeDocPath(decodedDocPath)) return;

        // Clear restructuring suppression — the sections refresh will mount new editors.
        setRestructuringKeys(new Set());

        // Capture current focus heading path for restoration after sections reload.
        // The CrdtProvider stays alive — the Y.Doc and connection are still valid.
        // React will unmount editors whose fragment keys disappeared and mount new
        // ones for the new fragment keys. New editors bind to fragments the server
        // already populated in the same Y.Doc.
        const fi = focusedSectionIndexRef.current;
        const secs = sectionsRef.current;
        if (fi !== null && secs[fi]) {
          pendingStructureRefocusRef.current = secs[fi].heading_path;
        }

        // Snapshot old section keys before reload so we can detect removals.
        const oldKeys = new Set(secs.map((s) => fragmentKeyFromSectionFile(s.section_file, s.heading_path)));

        // Refresh section list and structure tree, then detect removed sections.
        loadSections(decodedDocPath).then(() => {
          // If editing ended (e.g. idle timeout closed CRDT socket), don't create
          // placeholders — the session is over and SESSION_FLUSHED will never arrive
          // on the dead socket to clear them.
          if (focusedSectionIndexRef.current === null) return;

          const newKeys = new Set(sectionsRef.current.map((s) => fragmentKeyFromSectionFile(s.section_file, s.heading_path)));
          const removedKeys = [...oldKeys].filter((k) => !newKeys.has(k));
          if (removedKeys.length > 0) {
            setDeletionPlaceholders((prev) => {
              const next = [...prev];
              for (const rk of removedKeys) {
                if (next.some((p) => p.fragmentKey === rk)) continue;
                // Find the old section's heading from the snapshot
                const oldSec = secs.find((s) => fragmentKeyFromSectionFile(s.section_file, s.heading_path) === rk);
                next.push({
                  fragmentKey: rk,
                  formerHeading: oldSec ? (oldSec.heading_path[oldSec.heading_path.length - 1] ?? "") : "",
                  insertAfterIndex: -1,
                });
              }
              return next;
            });
            // Mark deleted sections as "deleting" in persistence map
            setSectionPersistence((prev) => {
              const next = new Map(prev);
              for (const rk of removedKeys) next.set(rk, "deleting");
              return next;
            });
          }
        });
        apiClient.getDocumentStructure(decodedDocPath).then((resp) => {
          setStructureTree(resp.structure);
        }).catch(() => { /* non-fatal background fetch */ });
        return;
      }

      // ── proposal:created ──
      if (event.type === "proposal:pending") {
        const created = event as ProposalPendingEvent;
        if (normalizeDocPath(created.doc_path) !== normalizeDocPath(decodedDocPath)) return;

        setPendingProposalIndicators((prev) => {
          const next = [...prev];
          for (const hp of created.heading_paths) {
            const sectionKey = sectionHeadingKey(hp);
            const key = `${created.proposal_id}:${sectionKey}`;
            if (!next.some((ind) => ind.proposalId === created.proposal_id && ind.sectionKey === sectionKey)) {
              next.push({
                proposalId: created.proposal_id,
                sectionKey,
                writerDisplayName: created.writer_display_name,
                intent: created.intent,
              });
            }
          }
          return next;
        });
        return;
      }

      // ── proposal:withdrawn ──
      if (event.type === "proposal:withdrawn") {
        const withdrawn = event as ProposalWithdrawnEvent;
        setPendingProposalIndicators((prev) =>
          prev.filter((ind) => ind.proposalId !== withdrawn.proposal_id),
        );
        return;
      }
    });
    return () => {
      wsClient.unsubscribe(decodedDocPath);
      wsClient.disconnect();
    };
  }, [decodedDocPath, wsClient, loadSections, navigate]);

  // ── Handle idle timeout: CRDT disconnects while editing → silently return to read view ──
  useEffect(() => {
    if (
      crdtState === "disconnected"
      && focusedSectionIndex !== null
      && !editingLoading
    ) {
      stopEditing();
      if (decodedDocPath) {
        loadSections(decodedDocPath);
      }
    }
  }, [crdtState, focusedSectionIndex, editingLoading, stopEditing, decodedDocPath, loadSections]);

  // ── Enter edit mode: create one provider per document ──
  const ensureProvider = useCallback(async (): Promise<CrdtProvider | null> => {
    if (!decodedDocPath) return null;

    // Already have an active provider for this document
    if (crdtProviderRef.current) return crdtProviderRef.current;

    setCrdtError(null);
    setStatusMessage(null);
    setError(null);
    setEditingLoading(true);

    try {
      const doc = new Y.Doc();
      const provider = new CrdtProvider(doc, decodedDocPath, {
        onStateChange: (state: CrdtConnectionState) => {
          setCrdtState(state);
        },
        onSynced: () => { /* Y.Doc now has server state */ },
        onError: (reason: string) => setCrdtError(`CRDT sync error: ${reason}`),
        onFlushStarted: () => {
          // All dirty sections → pending
          setSectionPersistence((prev) => {
            const next = new Map(prev);
            for (const [key, state] of next) {
              if (state === "dirty") next.set(key, "pending");
            }
            return next;
          });
        },
        onSessionFlushed: ({ writtenKeys, deletedKeys }) => {
          setSectionPersistence((prev) => {
            const next = new Map(prev);
            // Written keys → flushed (even if client didn't track them as dirty)
            for (const key of writtenKeys) {
              next.set(key, "flushed");
            }
            // Deleted keys → remove from map (placeholder handles UI)
            for (const key of deletedKeys) {
              next.delete(key);
            }
            return next;
          });
          // Resolve deletion placeholders for confirmed-deleted keys
          if (deletedKeys.length > 0) {
            setDeletionPlaceholders((prev) =>
              prev.filter((p) => !deletedKeys.includes(p.fragmentKey)),
            );
          }
        },
        onStructureWillChange: (restructures: StructureWillChangePayload[]) => {
          // Suppress rendering for fragments about to be restructured.
          // The Y.Doc mutation (clear + repopulate) will follow immediately.
          // Without this, the user sees empty/broken content between clear and repopulate.
          const keys = new Set<string>();
          for (const r of restructures) {
            keys.add(r.oldKey);
          }
          setRestructuringKeys(keys);
        },
        onLocalUpdate: (modifiedFragmentKeys: string[]) => {
          // Mark actually-modified fragments as dirty (decoupled from focusedSectionIndex)
          if (modifiedFragmentKeys.length > 0) {
            setSectionPersistence((prev) => {
              const next = new Map(prev);
              for (const fk of modifiedFragmentKeys) {
                next.set(fk, "dirty");
              }
              return next;
            });
          }
        },
        onIdleTimeout: () => {
          stopEditing();
          if (decodedDocPath) {
            loadSections(decodedDocPath);
          }
        },
      });
      provider.connect();
      setCrdtProvider(provider);
      crdtProviderRef.current = provider;
      setEditingLoading(false);
      return provider;
    } catch (err) {
      setEditingLoading(false);
      setCrdtError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [decodedDocPath, stopEditing, loadSections]);

  // ── viewingPresence: set Awareness viewingSections on focus change ──
  const setViewingSections = useCallback((provider: CrdtProvider, sectionIndex: number) => {
    const section = sections[sectionIndex];
    if (!section) return;
    const fk = fragmentKeyFromSectionFile(section.section_file, section.heading_path);
    // viewingPresence: client-informational, cosmetic UI only.
    // Signal source is editor focus for now; can be swapped to
    // IntersectionObserver without touching backend.
    const currentUser = provider.awareness.getLocalState()?.user;
    provider.awareness.setLocalStateField("user", {
      ...currentUser,
      viewingSections: [fk],
    });
  }, [sections]);

  // ── Click-to-edit a section ────────────────────────────
  const startEditing = useCallback(async (sectionIndex: number) => {
    const provider = await ensureProvider();
    if (!provider) return;

    setFocusedSectionIndex(sectionIndex);
    pendingFocusRef.current = { index: sectionIndex, position: "start" };

    // Notify server of section focus (editingPresence)
    const section = sections[sectionIndex];
    if (section) {
      provider.focusSection(section.heading_path);
    }
    // viewingPresence: broadcast which section we're viewing
    setViewingSections(provider, sectionIndex);
  }, [ensureProvider, sections, setViewingSections]);

  // ── Cross-section cursor navigation ─────────────────────
  const handleCursorExit = useCallback((sectionIndex: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? sectionIndex - 1 : sectionIndex + 1;
    if (targetIndex < 0 || targetIndex >= sections.length) return;

    setFocusedSectionIndex(targetIndex);
    pendingFocusRef.current = {
      index: targetIndex,
      position: direction === "up" ? "end" : "start",
    };

    // Notify server of section focus change (editingPresence)
    const provider = crdtProviderRef.current;
    const targetSection = sections[targetIndex];
    if (provider && targetSection) {
      provider.focusSection(targetSection.heading_path);
    }
    // viewingPresence: broadcast which section we're viewing
    if (provider) {
      setViewingSections(provider, targetIndex);
    }
  }, [sections, setViewingSections]);

  // ── Focus editor after focusedSectionIndex changes ──────
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const { index, position } = pendingFocusRef.current;

    // Use requestAnimationFrame to wait for the editor to mount
    const raf = requestAnimationFrame(() => {
      const handle = editorRefs.current.get(index);
      if (handle) {
        handle.focus(position);
      }
      pendingFocusRef.current = null;
    });

    return () => cancelAnimationFrame(raf);
  }, [focusedSectionIndex]);

  // ── Restore focus after doc_structure:changed re-fetches sections ──
  useEffect(() => {
    const refocusPath = pendingStructureRefocusRef.current;
    if (!refocusPath || !crdtProviderRef.current) return;
    pendingStructureRefocusRef.current = null;

    // Find the section whose heading path matches the old focus.
    // After a split, the original heading is still the first fragment,
    // so exact match should work.
    const exactIdx = sections.findIndex(
      (s) => sectionHeadingKey(s.heading_path) === sectionHeadingKey(refocusPath),
    );

    if (exactIdx >= 0) {
      setFocusedSectionIndex(exactIdx);
      pendingFocusRef.current = { index: exactIdx, position: "end" };
      crdtProviderRef.current.focusSection(sections[exactIdx].heading_path);
    } else {
      // Heading was renamed or removed — drop focus (user knows where they are)
      setFocusedSectionIndex(null);
    }
  }, [sections]);

  // ── Editor ref callback ─────────────────────────────────
  const setEditorRef = useCallback((index: number, handle: MilkdownEditorHandle | null) => {
    if (handle) {
      editorRefs.current.set(index, handle);
    } else {
      editorRefs.current.delete(index);
    }
  }, []);

  // Build a lookup of presence indicators by section key
  const presenceBySectionKey = useMemo(() => {
    const map = new Map<string, PresenceIndicator[]>();
    for (const indicator of presenceIndicators) {
      const existing = map.get(indicator.sectionKey) ?? [];
      existing.push(indicator);
      map.set(indicator.sectionKey, existing);
    }
    return map;
  }, [presenceIndicators]);

  // Build a lookup of pending proposal indicators by section key
  const proposalsBySectionKey = useMemo(() => {
    const map = new Map<string, PendingProposalIndicator[]>();
    for (const indicator of pendingProposalIndicators) {
      const existing = map.get(indicator.sectionKey) ?? [];
      existing.push(indicator);
      map.set(indicator.sectionKey, existing);
    }
    return map;
  }, [pendingProposalIndicators]);

  // ── Derived ──────────────────────────────────────────────
  const docTitle = decodedDocPath ? getDocDisplayName(decodedDocPath) : "Untitled";

  // Aggregated persistence summary — derived from per-section map (never lies)
  const persistenceSummary = useMemo(() => {
    let dirtyCount = 0;
    let pendingCount = 0;
    let flushedCount = 0;
    let deletingCount = 0;
    for (const state of sectionPersistence.values()) {
      if (state === "dirty") dirtyCount++;
      else if (state === "pending") pendingCount++;
      else if (state === "flushed") flushedCount++;
      else if (state === "deleting") deletingCount++;
    }
    return { dirtyCount, pendingCount, flushedCount, deletingCount, total: sectionPersistence.size };
  }, [sectionPersistence]);

  // ── Render ───────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Topbar */}
      <header className="h-[--spacing-topbar-h] min-h-[--spacing-topbar-h] bg-topbar-bg border-b border-topbar-border flex items-center px-4 gap-2.5">
        <Link
          to="/docs"
          className="w-[26px] h-[26px] rounded-[5px] flex items-center justify-center text-text-muted text-[15px] hover:bg-section-hover hover:text-text-primary transition-all"
        >
          &#8592;
        </Link>
        <span className="font-[family-name:var(--font-ui)] text-sm font-medium text-text-primary flex-1 truncate">
          {decodedDocPath ?? "No document selected"}
        </span>

        {/* Aggregated persistence indicator — derived from per-section state map */}
        <div className="flex items-center gap-[5px]">
          <div className={`w-[7px] h-[7px] rounded-full ${
            crdtState === "error" ? "bg-status-red"
            : crdtState === "reconnecting" ? "bg-status-red animate-[pulse-dot_1.5s_ease-in-out_infinite]"
            : crdtState === "connecting" ? "bg-status-yellow animate-[pulse-dot_1.5s_ease-in-out_infinite]"
            : persistenceSummary.pendingCount > 0 ? "bg-amber-400"
            : persistenceSummary.dirtyCount > 0 ? "bg-blue-400"
            : persistenceSummary.flushedCount > 0 ? "bg-status-green opacity-70"
            : persistenceSummary.total === 0 && isEditing ? "bg-status-green"
            : "bg-status-green"
          }`} />
          <span className="text-[11px] text-text-muted">
            {crdtState === "error" ? "Sync error"
            : crdtState === "reconnecting" ? "Reconnecting\u2026"
            : crdtState === "connecting" ? "Syncing\u2026"
            : persistenceSummary.pendingCount > 0 ? `${persistenceSummary.pendingCount} section${persistenceSummary.pendingCount > 1 ? "s" : ""} waiting for save confirmation`
            : persistenceSummary.dirtyCount > 0 ? `${persistenceSummary.dirtyCount} unsaved section${persistenceSummary.dirtyCount > 1 ? "s" : ""}`
            : persistenceSummary.flushedCount > 0 ? "All changes saved"
            : isEditing ? "Up to date"
            : ""}
          </span>
        </div>
      </header>

      {/* Document-level connection banner — visible only during transport failures */}
      {isEditing && crdtState === "reconnecting" ? (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-xs text-amber-800 font-medium">
          Reconnecting\u2026
        </div>
      ) : isEditing && (crdtState === "error" || crdtState === "disconnected") ? (
        <div className="bg-red-50 border-b border-red-200 px-4 py-1.5 text-xs text-red-800 font-medium">
          Offline &mdash; changes won&apos;t be saved
        </div>
      ) : null}

      {/* Canvas scroll area */}
      <div className="flex-1 overflow-y-auto canvas-scroll px-5 pt-8 pb-24" style={{ background: "var(--color-page-bg)" }}>
        <div ref={sectionsContainerRef} className="max-w-[700px] mx-auto bg-canvas-bg shadow-[0_1px_4px_rgba(0,0,0,0.04),0_6px_24px_rgba(0,0,0,0.025)] rounded-sm px-14 pt-12 pb-16 relative min-h-[calc(100vh-200px)]">
          {/* Document title */}
          <h1 className="font-[family-name:var(--font-body)] text-[32px] font-bold text-text-primary leading-tight mb-1 tracking-tight">
            {docTitle}
          </h1>
          <div className="text-xs text-text-muted mb-7 pb-5 border-b border-[#eae7e2] flex items-center gap-2">
            {renaming ? (
              <form
                className="flex items-center gap-1.5 flex-1"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!decodedDocPath || !renameValue.trim()) return;
                  setRenameError(null);
                  try {
                    await apiClient.renameDocument(decodedDocPath, renameValue.trim());
                    setRenaming(false);
                  } catch (err) {
                    setRenameError(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                <input
                  className="flex-1 text-xs border border-border-default rounded px-1.5 py-0.5 bg-canvas-bg text-text-primary"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="text-xs text-accent-primary hover:underline">Save</button>
                <button type="button" className="text-xs text-text-muted hover:underline" onClick={() => { setRenaming(false); setRenameError(null); }}>Cancel</button>
                {renameError && <span className="text-xs text-red-600">{renameError}</span>}
              </form>
            ) : (
              <>
                <span>{decodedDocPath ?? ""}</span>
                <button
                  className="text-xs text-accent-primary hover:underline ml-1"
                  onClick={() => { setRenameValue(decodedDocPath ?? ""); setRenaming(true); }}
                >
                  Rename
                </button>
              </>
            )}
          </div>

          {/* Agent reading indicators */}
          {agentReadingIndicators.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {agentReadingIndicators.map((indicator) => (
                <span key={indicator.key} className="inline-flex items-center gap-1 text-[10px] text-agent-text animate-[fade-assemble_3s_ease-in-out_infinite]">
                  <span className="text-xs">&#128065;</span>
                  {indicator.actorDisplayName} reading {indicator.labels.join(", ")}
                </span>
              ))}
            </div>
          ) : null}

          {/* Recently changed sections */}
          {recentlyChangedSections.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {recentlyChangedSections.sort((a, b) => b.changedAtMs - a.changedAtMs).map((entry) => (
                <span key={entry.key} className="inline-flex items-center gap-1 text-[10px] font-medium text-agent-text bg-agent-light px-[7px] py-px rounded-sm">
                  {entry.label} ({entry.changedByName}, {formatRelativeAgeFromMs(entry.changedAtMs)})
                </span>
              ))}
            </div>
          ) : null}

          {/* Status / error */}
          {statusMessage ? <p className="text-xs text-status-green mb-2">{statusMessage}</p> : null}
          {error ? <p className="text-xs text-status-red mb-2">Error: {error}</p> : null}

          {/* Loading state (only shown after LOADING_REVEAL_DELAY_MS to avoid flicker) */}
          {showLoading ? (
            structureTree ? (() => {
              const flatSkeleton = flattenStructureTree(structureTree);
              const sectionCount = flatSkeleton.length;
              return (
                <>
                  {/* Metadata summary banner */}
                  <div className="text-xs text-text-muted font-[family-name:var(--font-mono)] mb-4 p-2 bg-slate-50 rounded border border-slate-200">
                    <span>Loading {sectionCount.toLocaleString()} sections ({estimateDocSize(sectionCount)})...</span>
                    {sectionCount > 500 ? (
                      <span className="ml-2 text-amber-600">
                        Large document — consider splitting for better performance.
                      </span>
                    ) : null}
                  </div>

                  {/* Skeleton outline: heading tree with placeholder content bars */}
                  {flatSkeleton.map((entry) => {
                    const key = sectionHeadingKey(entry.headingPath);
                    const heading = entry.headingPath[entry.headingPath.length - 1] ?? "";
                    const depth = Math.max(1, entry.headingPath.length);
                    return (
                      <div
                        key={key}
                        className="relative m-[-16px] p-[4px_16px] rounded-md border-l-[2.5px] border-l-slate-200"
                      >
                        {heading ? (
                          <div className="doc-prose">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {`${"#".repeat(depth)} ${heading}`}
                            </ReactMarkdown>
                          </div>
                        ) : null}
                        <div className="space-y-1.5 mt-1 mb-2">
                          <div className="h-3 w-3/4 bg-slate-100 rounded animate-pulse" />
                          <div className="h-3 w-1/2 bg-slate-100 rounded animate-pulse" />
                        </div>
                      </div>
                    );
                  })}
                </>
              );
            })() : (
              <p className="text-sm text-text-muted">Loading document...</p>
            )
          ) : null}

          {/* Sections */}
          {!sectionsLoading && sections.length === 0 && !error ? (
            <p className="text-sm text-text-muted">Document is empty.</p>
          ) : null}

          {!sectionsLoading ? sections.map((section, i) => {
            const sectionKey = sectionHeadingKey(section.heading_path);
            const isFocused = focusedSectionIndex === i;
            const hasEditor = shouldMountEditor(i, focusedSectionIndex);
            const humanInvolvementScore = section.humanInvolvement_score ?? 0;
            const crdtActive = section.crdt_session_active;
            const sectionPresence = presenceBySectionKey.get(sectionKey) ?? [];
            const sectionProposals = proposalsBySectionKey.get(sectionKey) ?? [];
            const depth = headingDepth(section.heading_path);
            const heading = headingText(section.heading_path);
            const fk = fragmentKeyFromSectionFile(section.section_file, section.heading_path);
            const persistState = sectionPersistence.get(fk);
            const isRestructuring = restructuringKeys.has(fk);
            const isInProposal = proposalMode && proposalSectionsRef.current.has(
              `${decodedDocPath}::${sectionKey}`,
            );
            const isLockedByOtherHuman = !!(section as any).blocked;
            const sectionLabel = headingPathToLabel(section.heading_path);
            const highlightEntry = recentlyChangedByLabel.get(sectionLabel);

            return (
              <div
                key={fk}
                data-section-index={i}
                data-fragment-key={fk}
                data-heading-path={JSON.stringify(section.heading_path)}
                className={`relative mx-[-16px] px-[16px] py-[4px] rounded-md border-l-[2.5px] transition-all group ${
                  isLockedByOtherHuman
                    ? `bg-amber-50/50 border-l-amber-400 opacity-75`
                    : isInProposal
                    ? `bg-blue-50/30 border-l-blue-500`
                    : isFocused
                    ? `bg-[rgba(45,122,138,0.06)] border-l-accent`
                    : hasEditor
                    ? `bg-[rgba(45,122,138,0.02)] border-l-accent/40`
                    : highlightEntry
                    ? `bg-green-50/70 border-l-green-400 cursor-pointer hover:bg-section-hover`
                    : `cursor-pointer hover:bg-section-hover ${involvementBorderClass(humanInvolvementScore)}`
                }`}
                onClick={isLockedByOtherHuman ? undefined : hasEditor ? undefined : () => void startEditing(i)}
              >
                {/* Hover hint / editing label */}
                {!hasEditor && !isLockedByOtherHuman ? (
                  <span className="absolute top-1 right-2 text-[10px] text-text-muted bg-white/80 px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    Click to edit
                  </span>
                ) : isFocused ? (
                  <span className="text-[10px] font-medium text-accent mb-1 block">
                    {editingLoading ? "Connecting\u2026" : "Editing"}
                  </span>
                ) : null}

                {/* Section metadata badges */}
                <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                  {/* Per-section persistence dot */}
                  {persistState === "dirty" ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full">
                      <span className="w-[5px] h-[5px] rounded-full bg-blue-400" />
                      Unsaved
                    </span>
                  ) : persistState === "pending" ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-full">
                      <span className="w-[5px] h-[5px] rounded-full bg-amber-400" />
                      Saving\u2026
                    </span>
                  ) : persistState === "flushed" ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded-full">
                      <span className="w-[5px] h-[5px] rounded-full bg-green-500 opacity-70" />
                      Saved
                    </span>
                  ) : null}

                  {/* Proposal mode indicators */}
                  {isInProposal ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded-full">
                      <span className="w-[5px] h-[5px] rounded-full bg-blue-500" />
                      In proposal
                    </span>
                  ) : null}
                  {isLockedByOtherHuman ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-amber-700 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded-full">
                      Reserved by another user
                    </span>
                  ) : null}

                  {/* Active CRDT session indicator */}
                  {crdtActive && !hasEditor ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded-full">
                      <span className="w-[5px] h-[5px] rounded-full bg-accent animate-pulse" />
                      Active CRDT session
                    </span>
                  ) : null}

                  {/* editingPresence indicators for this section (server-authoritative) */}
                  {sectionPresence.map((p) => (
                    <span key={p.key} className="inline-flex items-center gap-1 text-[9px] font-medium text-agent-text bg-agent-light border border-agent-border px-1.5 py-0.5 rounded-full">
                      <span className="w-[5px] h-[5px] rounded-full bg-agent animate-[pulse-agent_2s_ease-in-out_infinite]" />
                      {p.writerDisplayName}
                    </span>
                  ))}

                  {/* viewingPresence dots (Awareness-based, cosmetic UI only) */}
                  <ViewingPresenceDots
                    awareness={crdtProviderRef.current?.awareness ?? null}
                    sectionKey={fk}
                  />

                  {/* Transient highlight: "Updated by {name}" annotation */}
                  {highlightEntry ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded-full">
                      Updated by {highlightEntry.changedByName}
                    </span>
                  ) : null}

                  {/* Pending proposal indicators */}
                  {sectionProposals.map((p) => (
                    <span key={p.proposalId} className="inline-flex items-center gap-1 text-[9px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                      <span className="w-[5px] h-[5px] rounded-full bg-amber-400 animate-pulse" />
                      Agent '{p.writerDisplayName}' wants to modify this section
                    </span>
                  ))}

                  {/* Human involvement score badge (only for non-zero scores) */}
                  {humanInvolvementScore > 0.3 ? (
                    <span className={`inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                      humanInvolvementScore > 0.5
                        ? "text-blue-700 bg-blue-50 border border-blue-200"
                        : "text-blue-500 bg-blue-50/50 border border-blue-100"
                    }`}>
                      {humanInvolvementScore > 0.5 ? "High" : "Medium"} human involvement ({humanInvolvementScore.toFixed(2)})
                    </span>
                  ) : null}
                </div>

                {/* Section body: editor or static preview */}
                {isRestructuring ? (
                  <div className="py-3">
                    <div className="space-y-1.5">
                      <div className="h-3 w-3/4 bg-slate-100 rounded animate-pulse" />
                      <div className="h-3 w-1/2 bg-slate-100 rounded animate-pulse" />
                    </div>
                  </div>
                ) : hasEditor ? (
                  crdtError ? (
                    <div className="border border-status-red rounded-md p-3 bg-status-red-light/30 text-sm text-status-red my-2">
                      <p className="font-semibold mb-1">CRDT connection failed</p>
                      <p className="text-xs">{crdtError}</p>
                    </div>
                  ) : (
                    <div
                      className="my-2 min-h-[60px]"
                      onClick={() => {
                        if (!isFocused) {
                          setFocusedSectionIndex(i);
                          pendingFocusRef.current = { index: i, position: "start" };
                          const provider = crdtProviderRef.current;
                          if (provider) {
                            provider.focusSection(section.heading_path);
                            setViewingSections(provider, i);
                          }
                        }
                      }}
                    >
                      <MilkdownEditor
                        ref={(handle) => setEditorRef(i, handle)}
                        markdown={section.content}
                        crdtProvider={proposalMode ? null : crdtProvider}
                        fragmentKey={fk}
                        userName={resolveWriterId()}
                        onChange={proposalMode ? (md) => handleProposalSectionChange(i, md) : undefined}
                        onCursorExit={(direction) => handleCursorExit(i, direction)}
                      />
                    </div>
                  )
                ) : (
                  <div className="doc-prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            );
          }) : null}

          {/* Deletion placeholders — sections removed but not yet confirmed by server */}
          {deletionPlaceholders.map((placeholder) => (
            <div
              key={`deleting:${placeholder.fragmentKey}`}
              className="relative m-[-16px] p-[4px_16px] rounded-md border-l-[2.5px] border-l-amber-300 bg-amber-50/30"
            >
              <div className="flex items-center gap-1.5 py-1">
                <span className="w-[5px] h-[5px] rounded-full bg-amber-400" />
                <span className="text-[10px] text-amber-700 line-through">{placeholder.formerHeading || "(document root)"}</span>
                <span className="text-[9px] text-amber-500 ml-1">Deletion pending\u2026</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="h-[--spacing-footer-h] min-h-[--spacing-footer-h] bg-footer-bg border-t border-footer-border flex items-center px-3.5 gap-1 text-[10.5px] text-footer-text font-[family-name:var(--font-mono)]">
        <span>{decodedDocPath ?? "No document"}</span>
        <span className="mx-1.5 text-[#d0ccc4]">&middot;</span>
        <span>{isEditing && focusedHeadingPath ? `Editing: ${headingPathToLabel(focusedHeadingPath)}` : "Connected"}</span>
        {loadDurationMs !== null ? (
          <>
            <span className="mx-1.5 text-[#d0ccc4]">&middot;</span>
            <span>Page loaded in {(loadDurationMs / 1000).toFixed(1)}s</span>
          </>
        ) : null}
      </div>

      {/* Proposal floating panel */}
      <ProposalPanel
        activeProposalId={activeProposalId}
        proposalMode={proposalMode}
        onEnterProposalMode={enterProposalMode}
        onExitProposalMode={exitProposalMode}
      />
    </div>
  );
}
