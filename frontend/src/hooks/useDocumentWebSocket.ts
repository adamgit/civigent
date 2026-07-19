import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient, resolveWriterId } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import {
  sectionHeadingKey,
  type AgentReadingEvent,
  type ContentCommittedEvent,
  type DocRenamedEvent,
  type DocStructureChangedEvent,
  type DocStructureNode,
  type ProposalDraftEvent,
  type ProposalInProgressEvent,
  type ProposalSectionAvailabilityEvent,
  type ProposalWithdrawnEvent,
  type SectionBlockStateEvent,
  type SectionEditRejectedEvent,
  type SectionPendingStateEvent,
} from "../types/shared.js";
import {
  type WorkspaceSectionDto,
  type RecentlyChangedSectionEntry,
  type AgentReadingIndicator,
  type PendingProposalIndicator,
  normalizeDocPath,
  headingPathToLabel,
  HIGHLIGHT_DURATION_MS,
} from "../pages/document-page-utils";

// ─── Hook parameters ─────────────────────────────────────────────

export interface UseDocumentWebSocketParams {
  decodedDocPath: string | null;
  /**
   * Stable per-tab client instance id, reused across mode transitions. Bound
   * to the JSON app WebSocket subscription so origin-only app events
   * (`section:edit-rejected`) route only to this tab.
   */
  clientInstanceId: string;
  /** True while the LiveSectionReplica holds an authoritative bootstrap. While
   *  ready, live topology/body events on this JSON socket are hints only. */
  liveReplicaReadyRef: React.MutableRefObject<boolean>;
  setStructureTree: React.Dispatch<React.SetStateAction<DocStructureNode[] | null>>;
  loadSections: (docPath: string) => Promise<WorkspaceSectionDto[]>;
  setError: (e: string | null) => void;
  onSectionsInjectedByProposal?: (headingPaths: string[][], writerDisplayName: string) => void;
  onProposalSectionAvailability?: (event: ProposalSectionAvailabilityEvent) => void;
  /**
   * Called when the server rejects one of this tab's CRDT live edits. The
   * event is origin-only (routed by `(doc_path, clientInstanceId)`) — the
   * document page opens an interruptive modal from the callback. Not routed
   * into generic error state, the topbar save status, or inline notices.
   */
  onSectionEditRejected?: (event: SectionEditRejectedEvent) => void;
  /**
   * Called whenever a proposal/lock lifecycle fact changed (`content:committed`,
   * `proposal:draft`, `proposal:inprogress`, `proposal:withdrawn`) so pages can
   * refresh section-keyed proposal/lock METADATA while the live replica is
   * ready. Deliberately not `loadSections` — the live path must never adopt
   * REST bodies/topology; implementations refresh meta maps only.
   */
  onProposalMetaChanged?: () => void;
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
  /** Section-keyed (heading-path key) in-progress proposal facts. */
  inProgressProposalsBySectionKey: Map<string, PendingProposalIndicator>;
  /** Cold hint (no live authority yet): fragment keys with a pending writer,
   *  from app-WS `section:pending`/`section:settled`. Ignored while the live
   *  replica is ready — live pending comes from the replica. */
  coldPendingByFragmentKey: Map<string, { writerId: string; writerDisplayName: string }>;
}

import { stripLeadingSlashForRoute } from "../app/docsRouteUtils";

// ─── Hook ─────────────────────────────────────────────────────────

export function useDocumentWebSocket({
  decodedDocPath,
  clientInstanceId,
  liveReplicaReadyRef,
  setStructureTree,
  loadSections,
  setError,
  onSectionsInjectedByProposal,
  onProposalSectionAvailability,
  onSectionEditRejected,
  onProposalMetaChanged,
}: UseDocumentWebSocketParams): UseDocumentWebSocketReturn {
  const navigate = useNavigate();

  // ── State ─────────────────────────────────────────────────
  const [recentlyChangedSections, setRecentlyChangedSections] = useState<RecentlyChangedSectionEntry[]>([]);

  // ── v3: Agent reading indicators ─────────────────────────
  const [agentReadingIndicators, setAgentReadingIndicators] = useState<AgentReadingIndicator[]>([]);

  // ── v3: Pending proposal indicators ─────────────────────
  const [pendingProposalIndicators, setPendingProposalIndicators] = useState<PendingProposalIndicator[]>([]);
  const pendingProposalIndicatorsRef = useRef<PendingProposalIndicator[]>([]);

  // ── In-progress proposal indicators (governance gutters) ──
  // Same shape/keying as the draft indicators, sourced from the
  // `proposal:inprogress` lifecycle event; cleared when the proposal resolves
  // (commit of its sections) or is withdrawn.
  const [inProgressProposalIndicators, setInProgressProposalIndicators] = useState<PendingProposalIndicator[]>([]);

  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);

  // Cold pending hints (no live authority yet) keyed by fragment key.
  const [coldPendingByFragmentKey, setColdPendingByFragmentKey] = useState<
    Map<string, { writerId: string; writerDisplayName: string }>
  >(new Map());

  const clearProposalIndicators = useCallback((proposalId: string) => {
    setPendingProposalIndicators((prev) =>
      prev.filter((indicator) => indicator.proposalId !== proposalId),
    );
  }, []);

  const clearInProgressIndicators = useCallback((proposalId: string) => {
    setInProgressProposalIndicators((prev) =>
      prev.filter((indicator) => indicator.proposalId !== proposalId),
    );
  }, []);

  const replaceInProgressIndicators = useCallback((event: ProposalInProgressEvent) => {
    const sectionKeys = new Set(event.heading_paths.map((headingPath) => sectionHeadingKey(headingPath)));
    setInProgressProposalIndicators((prev) => {
      const retained = prev.filter((indicator) => indicator.proposalId !== event.proposal_id);
      const next = [...retained];
      for (const sectionKey of sectionKeys) {
        next.push({
          proposalId: event.proposal_id,
          sectionKey,
          writerDisplayName: event.writer_display_name,
          intent: event.intent,
        });
      }
      return next;
    });
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
    // Bind the stable per-tab id at subscribe time so the hub/private-event
    // routing knows the identity of this document tab.
    wsClient.subscribe(decodedDocPath, clientInstanceId);
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

        // Clear draft + in-progress proposal indicators for committed sections
        const committedSectionKeys = new Set(
          committed.sections.map((s) => sectionHeadingKey(s.heading_path)),
        );
        setPendingProposalIndicators((prev) =>
          prev.filter((ind) => !committedSectionKeys.has(ind.sectionKey)),
        );
        setInProgressProposalIndicators((prev) =>
          prev.filter((ind) => !committedSectionKeys.has(ind.sectionKey)),
        );

        if (!liveReplicaReadyRef.current) {
          loadSections(decodedDocPath);
        }
        onProposalMetaChanged?.();
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

      if (
        event.type === "section:blocked" ||
        event.type === "section:unblocked" ||
        event.type === "section:gone"
      ) {
        return;
      }

      // ── section:edit-rejected ──
      // Origin-only expected rejection of one of THIS tab's CRDT live edits
      // (duplicate sibling heading, etc). The hub only delivers this event to
      // the tab whose edit was rejected. It is routed to a page-level rejection
      // handler that renders an interruptive modal — NOT the topbar save
      // status, NOT the generic error banner, NOT the block-state store.
      if (event.type === "section:edit-rejected") {
        const rejected = event as SectionEditRejectedEvent;
        if (normalizeDocPath(rejected.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        if (onSectionEditRejected) onSectionEditRejected(rejected);
        return;
      }

      if (event.type === "section:pending" || event.type === "section:settled") {
        const pendingState = event as SectionPendingStateEvent;
        if (normalizeDocPath(pendingState.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        // While the live replica is authoritative, live pending comes from the
        // CRDT `pending_sections` state — this JSON event is a cold hint only.
        if (liveReplicaReadyRef.current) return;
        setColdPendingByFragmentKey((prev) => {
          const next = new Map(prev);
          if (pendingState.type === "section:pending") {
            next.set(pendingState.fragment_key, {
              writerId: pendingState.writer_id ?? "",
              writerDisplayName: pendingState.writer_display_name ?? "",
            });
          } else {
            next.delete(pendingState.fragment_key);
          }
          return next;
        });
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

      if (event.type === "doc:structure-changed") {
        const structureChanged = event as DocStructureChangedEvent;
        if (normalizeDocPath(structureChanged.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        if (liveReplicaReadyRef.current) return;
        loadSections(decodedDocPath);
        return;
      }

      // ── proposal:created ──
      if (event.type === "proposal:draft") {
        const created = event as ProposalDraftEvent;
        if (normalizeDocPath(created.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        replaceDraftProposalIndicators(created);
        // A proposal back in draft (e.g. lock loss demotion) is no longer in progress.
        clearInProgressIndicators(created.proposal_id);
        onProposalMetaChanged?.();
        return;
      }

      // ── proposal:withdrawn ──
      if (event.type === "proposal:withdrawn") {
        const withdrawn = event as ProposalWithdrawnEvent;
        if (normalizeDocPath(withdrawn.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        clearProposalIndicators(withdrawn.proposal_id);
        clearInProgressIndicators(withdrawn.proposal_id);
        onProposalMetaChanged?.();
        return;
      }

      // ── proposal:inprogress ──
      if (event.type === "proposal:inprogress") {
        const inprogress = event as ProposalInProgressEvent;
        if (normalizeDocPath(inprogress.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        clearProposalIndicators(inprogress.proposal_id);
        replaceInProgressIndicators(inprogress);
        onProposalMetaChanged?.();
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
    clearInProgressIndicators,
    decodedDocPath,
    loadSections,
    navigate,
    onProposalSectionAvailability,
    onProposalMetaChanged,
    replaceDraftProposalIndicators,
    replaceInProgressIndicators,
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

  // Section-keyed in-progress proposal lookup (heading-path key — the FSM holds
  // one in-progress proposal per section, so a single fact per key).
  const inProgressProposalsBySectionKey = useMemo(() => {
    const map = new Map<string, PendingProposalIndicator>();
    for (const indicator of inProgressProposalIndicators) {
      map.set(indicator.sectionKey, indicator);
    }
    return map;
  }, [inProgressProposalIndicators]);

  return {
    wsClient,
    recentlyChangedSections,
    setRecentlyChangedSections,
    recentlyChangedByLabel,
    agentReadingIndicators,
    pendingProposalIndicators,
    pendingProposalIndicatorsRef,
    proposalsBySectionKey,
    inProgressProposalsBySectionKey,
    coldPendingByFragmentKey,
  };
}
