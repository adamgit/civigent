import { useEffect, useMemo, useRef, useState } from "react";
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
  type PresenceDoneEvent,
  type PresenceEditingEvent,
  type ProposalDraftEvent,
  type ProposalInjectedIntoSessionEvent,
  type ProposalWithdrawnEvent,
} from "../types/shared.js";
import {
  type SectionPersistenceState,
  type DeletionPlaceholder,
  type DocumentSection,
  type RecentlyChangedSectionEntry,
  type AgentReadingIndicator,
  type PresenceIndicator,
  type PendingProposalIndicator,
  normalizeDocPath,
  headingPathToLabel,
  getSectionFragmentKey,
  HIGHLIGHT_DURATION_MS,
} from "../pages/document-page-utils";
import type { CrdtProvider } from "../services/crdt-provider";

// ─── Hook parameters ─────────────────────────────────────────────

export interface UseDocumentWebSocketParams {
  decodedDocPath: string | null;
  sectionsRef: React.MutableRefObject<DocumentSection[]>;
  setSections: React.Dispatch<React.SetStateAction<DocumentSection[]>>;
  crdtProviderRef: React.MutableRefObject<CrdtProvider | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  /** Fragment keys of currently mounted Milkdown editors — used to exclude CRDT-bound
   *  sections from the REST refresh on content:committed without positional index coupling. */
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  setRestructuringKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSectionPersistence: React.Dispatch<React.SetStateAction<Map<string, SectionPersistenceState>>>;
  setDeletionPlaceholders: React.Dispatch<React.SetStateAction<DeletionPlaceholder[]>>;
  setStructureTree: React.Dispatch<React.SetStateAction<DocStructureNode[] | null>>;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  setError: (e: string | null) => void;
  onSectionsInjectedByProposal?: (headingPaths: string[][], writerDisplayName: string) => void;
}

// ─── Hook return type ─────────────────────────────────────────────

export interface UseDocumentWebSocketReturn {
  wsClient: KnowledgeStoreWsClient;
  recentlyChangedSections: RecentlyChangedSectionEntry[];
  setRecentlyChangedSections: React.Dispatch<React.SetStateAction<RecentlyChangedSectionEntry[]>>;
  recentlyChangedByLabel: Map<string, RecentlyChangedSectionEntry>;
  agentReadingIndicators: AgentReadingIndicator[];
  presenceIndicators: PresenceIndicator[];
  presenceIndicatorsRef: React.MutableRefObject<PresenceIndicator[]>;
  pendingProposalIndicators: PendingProposalIndicator[];
  pendingProposalIndicatorsRef: React.MutableRefObject<PendingProposalIndicator[]>;
  presenceBySectionKey: Map<string, PresenceIndicator[]>;
  proposalsBySectionKey: Map<string, PendingProposalIndicator[]>;
}

import { stripLeadingSlashForRoute } from "../app/docsRouteUtils";

// ─── Hook ─────────────────────────────────────────────────────────

export function useDocumentWebSocket({
  decodedDocPath,
  sectionsRef,
  setSections,
  crdtProviderRef,
  focusedSectionIndexRef,
  mountedEditorFragmentKeysRef,
  pendingStructureRefocusRef,
  setRestructuringKeys,
  setSectionPersistence,
  setDeletionPlaceholders,
  setStructureTree,
  loadSections,
  setError,
  onSectionsInjectedByProposal,
}: UseDocumentWebSocketParams): UseDocumentWebSocketReturn {
  const navigate = useNavigate();

  // ── State ─────────────────────────────────────────────────
  const [recentlyChangedSections, setRecentlyChangedSections] = useState<RecentlyChangedSectionEntry[]>([]);

  // ── v3: Agent reading indicators ─────────────────────────
  const [agentReadingIndicators, setAgentReadingIndicators] = useState<AgentReadingIndicator[]>([]);

  // ── v3: Presence indicators ──────────────────────────────
  const [presenceIndicators, setPresenceIndicators] = useState<PresenceIndicator[]>([]);
  const presenceIndicatorsRef = useRef<PresenceIndicator[]>([]);

  // ── v3: Pending proposal indicators ─────────────────────
  const [pendingProposalIndicators, setPendingProposalIndicators] = useState<PendingProposalIndicator[]>([]);
  const pendingProposalIndicatorsRef = useRef<PendingProposalIndicator[]>([]);

  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);

  // ── Ref sync for presence (used by WS handler) ────────────
  useEffect(() => {
    presenceIndicatorsRef.current = presenceIndicators;
  }, [presenceIndicators]);

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

        // Committed sections → clean in the persistence map
        const myWriterId = resolveWriterId();
        const isMyCommit = committed.writer_id === myWriterId ||
          (committed.contributor_ids?.includes(myWriterId) ?? false);
        if (isMyCommit) {
          setSectionPersistence((prev) => {
            const next = new Map(prev);
            for (const s of committed.sections) {
              // Look up section_file from current sections state
              const hpKey = sectionHeadingKey(s.heading_path);
              const match = sectionsRef.current.find((sec) => sectionHeadingKey(sec.heading_path) === hpKey);
              if (match) {
                const fk = getSectionFragmentKey(match);
                next.delete(fk); // clean = absent from the map
              }
            }
            return next;
          });
        }

        // Clear draft proposal indicators for committed sections
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
          // Exclude sections whose fragment key appears in mountedEditorFragmentKeysRef
          // (identity-based, not positional ±1 — safe under insert/reorder/structure change).
          apiClient.getDocumentSections(decodedDocPath).then((resp) => {
            const crdtBound = mountedEditorFragmentKeysRef.current;
            setSections((prev) => {
              const next = [...prev];
              const freshByKey = new Map(
                resp.sections.map((s) => [sectionHeadingKey(s.heading_path), s]),
              );
              for (let i = 0; i < next.length; i++) {
                const fk = getSectionFragmentKey(next[i]);
                if (crdtBound.has(fk)) continue; // skip sections with live editors
                const key = sectionHeadingKey(next[i].heading_path);
                const fresh = freshByKey.get(key);
                if (fresh) {
                  next[i] = fresh;
                }
              }
              // If section count changed (structure changed), use fresh list but
              // only when no CRDT editor is mounted to avoid disruption.
              if (resp.sections.length !== prev.length && crdtBound.size === 0) {
                return resp.sections;
              }
              return next;
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

      // ── presence:editing (v3) ──
      if (event.type === "presence:editing") {
        const presence = event as PresenceEditingEvent;
        if (normalizeDocPath(presence.doc_path) !== normalizeDocPath(decodedDocPath)) return;

        const sectionKey = sectionHeadingKey(presence.heading_path);
        const key = `${presence.writer_id}:${sectionKey}`;

        setPresenceIndicators((prev) => {
          const next = new Map(prev.map((ind) => [ind.key, ind]));
          next.set(key, {
            key,
            sectionKey,
            writerDisplayName: presence.writer_display_name,
            writerType: presence.writer_type,
          });
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
          navigate(`/docs/${stripLeadingSlashForRoute(renamed.new_path)}`, { replace: true });
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
        const oldKeys = new Set(secs.map((s) => getSectionFragmentKey(s)));

        // Refresh section list and structure tree, then detect removed sections.
        // Use the returned sections directly — sectionsRef.current is not yet updated
        // at .then() time because React batches setSections into the next render cycle.
        loadSections(decodedDocPath).then((newSections) => {
          // If editing ended (e.g. idle timeout closed CRDT socket), don't create
          // placeholders — the session is over and SESSION_FLUSHED will never arrive
          // on the dead socket to clear them.
          if (mountedEditorFragmentKeysRef.current.size === 0) return;

          const newKeys = new Set(newSections.map((s) => getSectionFragmentKey(s)));
          const removedKeys = [...oldKeys].filter((k) => !newKeys.has(k));
          if (removedKeys.length > 0) {
            setDeletionPlaceholders((prev) => {
              const next = [...prev];
              for (const rk of removedKeys) {
                if (next.some((p) => p.fragmentKey === rk)) continue;
                // Find the old section's heading from the snapshot
                const oldSec = secs.find((s) => getSectionFragmentKey(s) === rk);
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
      if (event.type === "proposal:draft") {
        const created = event as ProposalDraftEvent;
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

      // ── proposal:injected_into_session ──
      if (event.type === "proposal:injected_into_session") {
        const injected = event as ProposalInjectedIntoSessionEvent;
        if (normalizeDocPath(injected.doc_path) !== normalizeDocPath(decodedDocPath)) return;
        if (onSectionsInjectedByProposal) {
          onSectionsInjectedByProposal(injected.heading_paths, injected.writer_display_name);
        }
        return;
      }
    });
    return () => {
      wsClient.unsubscribe(decodedDocPath);
      wsClient.disconnect();
    };
  }, [decodedDocPath, wsClient, loadSections, navigate]);

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
    presenceIndicators,
    presenceIndicatorsRef,
    pendingProposalIndicators,
    pendingProposalIndicatorsRef,
    presenceBySectionKey,
    proposalsBySectionKey,
  };
}
