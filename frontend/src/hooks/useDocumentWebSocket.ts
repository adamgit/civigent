import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient, resolveWriterId } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import {
  sectionHeadingKey,
  type AgentReadingEvent,
  type ContentCommittedEvent,
  type DocRenamedEvent,
  type DocStructureNode,
  type ProposalDraftEvent,
  type ProposalInProgressEvent,
  type ProposalSectionAvailabilityEvent,
  type ProposalWithdrawnEvent,
  type SectionBlockStateEvent,
  type SectionPendingStateEvent,
} from "../types/shared.js";
import {
  type DocumentSection,
  type RecentlyChangedSectionEntry,
  type AgentReadingIndicator,
  type PendingProposalIndicator,
  normalizeDocPath,
  headingPathToLabel,
  getSectionFragmentKey,
  HIGHLIGHT_DURATION_MS,
} from "../pages/document-page-utils";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";

// ─── Hook parameters ─────────────────────────────────────────────

export interface UseDocumentWebSocketParams {
  decodedDocPath: string | null;
  sectionsRef: React.MutableRefObject<DocumentSection[]>;
  setSections: React.Dispatch<React.SetStateAction<DocumentSection[]>>;
  transportRef: React.MutableRefObject<CrdtTransport | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  /** Fragment keys of currently mounted Milkdown editors — used to exclude CRDT-bound
   *  sections from the REST refresh on content:committed without positional index coupling. */
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  storeRef: React.MutableRefObject<BrowserFragmentReplicaStore | null>;
  setStructureTree: React.Dispatch<React.SetStateAction<DocStructureNode[] | null>>;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  setError: (e: string | null) => void;
  onSectionsInjectedByProposal?: (headingPaths: string[][], writerDisplayName: string) => void;
  onProposalSectionAvailability?: (event: ProposalSectionAvailabilityEvent) => void;
}

// ─── Hook return type ─────────────────────────────────────────────

export interface UseDocumentWebSocketReturn {
  wsClient: KnowledgeStoreWsClient;
  recentlyChangedSections: RecentlyChangedSectionEntry[];
  setRecentlyChangedSections: React.Dispatch<React.SetStateAction<RecentlyChangedSectionEntry[]>>;
  recentlyChangedByLabel: Map<string, RecentlyChangedSectionEntry>;
  agentReadingIndicators: AgentReadingIndicator[];
  pendingProposalIndicators: PendingProposalIndicator[];
  pendingProposalIndicatorsRef: React.MutableRefObject<PendingProposalIndicator[]>;
  proposalsBySectionKey: Map<string, PendingProposalIndicator[]>;
}

import { stripLeadingSlashForRoute } from "../app/docsRouteUtils";

// ─── Hook ─────────────────────────────────────────────────────────

export function useDocumentWebSocket({
  decodedDocPath,
  sectionsRef,
  setSections,
  transportRef,
  focusedSectionIndexRef,
  mountedEditorFragmentKeysRef,
  pendingStructureRefocusRef,
  storeRef,
  setStructureTree,
  loadSections,
  setError,
  onSectionsInjectedByProposal,
  onProposalSectionAvailability,
}: UseDocumentWebSocketParams): UseDocumentWebSocketReturn {
  const navigate = useNavigate();

  // ── State ─────────────────────────────────────────────────
  const [recentlyChangedSections, setRecentlyChangedSections] = useState<RecentlyChangedSectionEntry[]>([]);

  // ── v3: Agent reading indicators ─────────────────────────
  const [agentReadingIndicators, setAgentReadingIndicators] = useState<AgentReadingIndicator[]>([]);

  // ── v3: Pending proposal indicators ─────────────────────
  const [pendingProposalIndicators, setPendingProposalIndicators] = useState<PendingProposalIndicator[]>([]);
  const pendingProposalIndicatorsRef = useRef<PendingProposalIndicator[]>([]);

  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);

  const clearProposalIndicators = useCallback((proposalId: string) => {
    setPendingProposalIndicators((prev) =>
      prev.filter((indicator) => indicator.proposalId !== proposalId),
    );
  }, []);

  const replaceDraftProposalIndicators = useCallback((draftEvent: ProposalDraftEvent) => {
    const sectionKeys = new Set(draftEvent.heading_paths.map((headingPath) => sectionHeadingKey(headingPath)));
    setPendingProposalIndicators((prev) => {
      const retained = prev.filter((indicator) => indicator.proposalId !== draftEvent.proposal_id);
      const next = [...retained];
      for (const sectionKey of sectionKeys) {
        next.push({
          proposalId: draftEvent.proposal_id,
          sectionKey,
          writerDisplayName: draftEvent.writer_display_name,
          intent: draftEvent.intent,
        });
      }
      return next;
    });
  }, []);

  useEffect(() => {
    pendingProposalIndicatorsRef.current = pendingProposalIndicators;
  }, [pendingProposalIndicators]);

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

        // `content:committed` is a canonical-refresh hint (spec 06 §"Refresh
        // Strategy"); the REST refresh below adopts fresh server topology while
        // preserving mounted editor content by fragment_key.

        // Clear draft proposal indicators for committed sections
        const committedSectionKeys = new Set(
          committed.sections.map((s) => sectionHeadingKey(s.heading_path)),
        );
        setPendingProposalIndicators((prev) =>
          prev.filter((ind) => !committedSectionKeys.has(ind.sectionKey)),
        );

        // Refresh sections to pick up new content
        if (!transportRef.current) {
          // No active CRDT session — full reload is safe
          loadSections(decodedDocPath);
        } else {
          // CRDT session active: adopt fresh server topology even while editors are
          // mounted; only a mounted section's live content is preserved. Matched by
          // opaque fragment_key — never positional index or heading text.
          apiClient.getDocumentSections(decodedDocPath).then((resp) => {
            const crdtBound = mountedEditorFragmentKeysRef.current;
            setSections((prev) => {
              const prevByFragmentKey = new Map(
                prev.map((s) => [getSectionFragmentKey(s), s]),
              );
              const nextSections = resp.sections.map((fresh) => {
                const fk = getSectionFragmentKey(fresh);
                if (crdtBound.has(fk)) {
                  const prevSection = prevByFragmentKey.get(fk);
                  if (prevSection) return { ...fresh, content: prevSection.content };
                }
                return fresh;
              });
              // Reconcile focus by fragment identity: keep focus on the focused
              // fragment's NEW index, or clear it if that fragment no longer exists.
              const focusedIndex = focusedSectionIndexRef.current;
              if (focusedIndex !== null && focusedIndex >= 0 && focusedIndex < prev.length) {
                const focusedFk = getSectionFragmentKey(prev[focusedIndex]);
                const newIndex = nextSections.findIndex(
                  (s) => getSectionFragmentKey(s) === focusedFk,
                );
                focusedSectionIndexRef.current = newIndex >= 0 ? newIndex : null;
              }
              return nextSections;
            });
          }).catch((err) => {
            setError(`Failed to refresh sections after commit: ${err instanceof Error ? err.message : String(err)}`);
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

      // ── section:blocked | section:unblocked | section:gone ──
      // Per-section CRDT block-state (spec 05 §"Section block-state events").
      // These ride the JSON application WebSocket and keep the browser mount Set
      // in lockstep with server reality. Routed into the replica store, which
      // owns the per-section editability map. (Provider does NOT handle these —
      // exactly one path; see crdt-provider.ts header.)
      if (
        event.type === "section:blocked" ||
        event.type === "section:unblocked" ||
        event.type === "section:gone"
      ) {
        const blockState = event as SectionBlockStateEvent;
        if (normalizeDocPath(blockState.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        const store = storeRef.current;
        if (store) {
          if (blockState.type === "section:blocked") store.setSectionBlocked(blockState.fragment_key);
          else if (blockState.type === "section:unblocked") store.setSectionUnblocked(blockState.fragment_key);
          else store.setSectionGone(blockState.fragment_key);
        }
        return;
      }

      // ── section:pending | section:settled ──
      // Guarantee B: a section gained (or settled) uncommitted edits in a live
      // DocSession inprogress proposal. Routed into the replica store, which owns
      // the per-section pending map (keyed by fragment_key, like block-state).
      if (event.type === "section:pending" || event.type === "section:settled") {
        const pendingState = event as SectionPendingStateEvent;
        if (normalizeDocPath(pendingState.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        const store = storeRef.current;
        if (store) {
          if (pendingState.type === "section:pending") {
            store.setSectionPending(pendingState.fragment_key, {
              writerId: pendingState.writer_id ?? "",
              writerDisplayName: pendingState.writer_display_name ?? "",
            });
          } else {
            store.setSectionSettled(pendingState.fragment_key);
          }
        }
        return;
      }

      // ── doc:renamed ──
      if (event.type === "doc:renamed") {
        const renamed = event as DocRenamedEvent;
        if (normalizeDocPath(renamed.old_path) === normalizeDocPath(decodedDocPath)) {
          navigate(`/docs/${stripLeadingSlashForRoute(renamed.new_path)}`, { replace: true });
        }
        return;
      }

      // Structural changes arrive as ordinary YJS_UPDATE deltas on the CRDT
      // socket; canonical previews refresh on `content:committed`.

      // ── proposal:created ──
      if (event.type === "proposal:draft") {
        const created = event as ProposalDraftEvent;
        if (normalizeDocPath(created.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        replaceDraftProposalIndicators(created);
        return;
      }

      // ── proposal:withdrawn ──
      if (event.type === "proposal:withdrawn") {
        const withdrawn = event as ProposalWithdrawnEvent;
        if (normalizeDocPath(withdrawn.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        clearProposalIndicators(withdrawn.proposal_id);
        return;
      }

      // ── proposal:inprogress ──
      if (event.type === "proposal:inprogress") {
        const inprogress = event as ProposalInProgressEvent;
        if (normalizeDocPath(inprogress.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        clearProposalIndicators(inprogress.proposal_id);
        return;
      }

      if (event.type === "proposal:section-availability") {
        const availability = event as ProposalSectionAvailabilityEvent;
        if (
          !availability.sections.some((section) =>
            normalizeDocPath(section.doc_path) === normalizeDocPath(decodedDocPath)
          )
        ) {
          return;
        }
        onProposalSectionAvailability?.(availability);
        return;
      }
    });
    return () => {
      wsClient.unsubscribe(decodedDocPath);
      wsClient.disconnect();
    };
  }, [
    clearProposalIndicators,
    decodedDocPath,
    loadSections,
    navigate,
    onProposalSectionAvailability,
    replaceDraftProposalIndicators,
    setError,
    wsClient,
  ]);

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

  // Build a lookup of draft proposal indicators by section key
  const proposalsBySectionKey = useMemo(() => {
    const map = new Map<string, PendingProposalIndicator[]>();
    for (const indicator of pendingProposalIndicators) {
      const existing = map.get(indicator.sectionKey) ?? [];
      existing.push(indicator);
      map.set(indicator.sectionKey, existing);
    }
    return map;
  }, [pendingProposalIndicators]);

  return {
    wsClient,
    recentlyChangedSections,
    setRecentlyChangedSections,
    recentlyChangedByLabel,
    agentReadingIndicators,
    pendingProposalIndicators,
    pendingProposalIndicatorsRef,
    proposalsBySectionKey,
  };
}
