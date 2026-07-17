/**
 * Build the authoritative `WireLiveSectionsState` snapshot for a live DocSession.
 *
 * This is the JSON, body-free live-section control state that rides the ordered
 * DocSession CRDT socket (bootstrap + update frames, `crdt-ws-frames.ts`). It is
 * captured on the actor lane so it describes a single consistent post-command
 * server state — topology, editability, pending-writer state, and the
 * publish-pause mirror — never assembled from a REST snapshot plus unordered
 * application-WebSocket events.
 *
 * Body text is deliberately absent: live bodies exist only in the Yjs update
 * that accompanies the frame. Topology is `fragment_key` + `heading_path` only;
 * everything the old section DTO carried on top of that (content, word-count,
 * agentWritePolicy, section_file, last_editor) is sourced elsewhere.
 */

import type { WireLiveSectionsState, WireLiveSectionRef, WirePendingSection } from "../types/shared.js";
import type { DocSession } from "./ydoc-lifecycle.js";
import { resolveLiveSectionLayout } from "./live-section-layout.js";

/**
 * Capture the current live-section control state for a DocSession. Call INSIDE
 * the session's actor lane (`session.enqueue`) so the returned snapshot cannot
 * interleave with a concurrent mutation.
 *
 * `pendingSections` is the doc's live pending-writer set, passed IN by the caller
 * (the coordinator, which owns `pendingFragmentsByDoc`). Passing it as a param —
 * rather than importing the coordinator here — avoids a coordinator↔wire-state
 * import cycle (the coordinator already imports this builder). It is filtered to the
 * fragments actually present in the current topology so a stale pending entry for a
 * merged-away fragment can never leak onto the wire.
 */
export async function buildWireLiveSectionsState(
  session: DocSession,
  pendingSections: readonly WirePendingSection[] = [],
): Promise<WireLiveSectionsState> {
  const currentProposalId = session.generator.getCurrentProposalId();
  const layout = await resolveLiveSectionLayout(session.docPath, currentProposalId);

  const topology: WireLiveSectionRef[] = layout.map((entry) => ({
    fragment_key: entry.fragmentKey,
    heading_path: [...entry.headingPath],
  }));

  const blocked_section_ids = await resolveBlockedFragmentKeys(session, layout, currentProposalId);

  // Live pending-writer set for THIS doc, sourced by the coordinator and filtered to
  // fragments still in the topology (a merged-away pending fragment must not leak).
  const topologyKeys = new Set(topology.map((t) => t.fragment_key));
  const pending_sections: WirePendingSection[] = pendingSections
    .filter((p) => topologyKeys.has(p.fragment_key))
    .map((p) => ({
      fragment_key: p.fragment_key,
      writer_id: p.writer_id,
      writer_display_name: p.writer_display_name,
    }));

  return {
    topology,
    blocked_section_ids,
    pending_sections,
    // Passive join/UI mirror — NOT a freeze command. The opcode handshake
    // (`0x10`/`0x11`/`0x12`) is the sole authority for the pause machine; this only
    // lets a late joiner reflect an in-flight pause in its UI / `isEditable()`.
    publish_pause_join_mirror: session.publishPause.isActive()
      ? "pause_active_editors_frozen"
      : "not_in_pause",
  };
}

/**
 * The editable-set blocked ids: fragment keys whose section is currently held by
 * a BLOCKING proposal FSM lock owned by *another* proposal (the session's own
 * `inprogress` proposal is excluded, matching the section-list `blocked` rule).
 * This unifies the old declared-`locked` vs emitted-`blocked` drift into one
 * representation, seeded from the authoritative lock index rather than replayed
 * from unordered `section:blocked`/`unblocked` events.
 */
async function resolveBlockedFragmentKeys(
  session: DocSession,
  layout: Awaited<ReturnType<typeof resolveLiveSectionLayout>>,
  currentProposalId: string | null,
): Promise<string[]> {
  const { ProposalFsmLockIndex } = await import("../domain/proposal-fsm-lock-index.js");
  const { BLOCKING_LOCK_STATUSES } = await import("../domain/proposal-fsm-locks.js");
  const lockIndex = await ProposalFsmLockIndex.build({
    statuses: BLOCKING_LOCK_STATUSES,
    excludeProposalId: currentProposalId ?? undefined,
  });
  const blocked: string[] = [];
  for (const entry of layout) {
    const held = lockIndex.holderFor({
      kind: "section",
      doc_path: session.docPath,
      heading_path: entry.headingPath,
    });
    if (held) blocked.push(entry.fragmentKey);
  }
  return blocked;
}
