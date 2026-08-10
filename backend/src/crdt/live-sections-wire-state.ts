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
 * that accompanies the frame. Topology is `fragment_key` + `heading_path` +
 * ATX `level` only; everything the old section DTO carried on top of that
 * (content, word-count, agentWritePolicy, section_file, last_editor) is
 * sourced elsewhere.
 */

import type { WireLiveSectionsState, WireLiveSectionRef, WirePendingSection, WireClaimedSection, ProposalSectionTargetRef } from "../types/shared.js";
import { sectionTargetToHeadingPath } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";
import type { DocSession } from "./ydoc-lifecycle.js";
import { resolveLiveSectionLayout } from "./live-section-layout.js";
import {
  buildCurrentPublishSignals,
  type EditorFocusState,
} from "./publish-trigger-signals.js";

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
  editorFocusStates: readonly EditorFocusState[] = [],
): Promise<WireLiveSectionsState> {
  const currentProposalId = session.generator.getCurrentProposalId();
  const layout = await resolveLiveSectionLayout(session.docPath, currentProposalId);

  const topology: WireLiveSectionRef[] = layout.map((entry) => ({
    fragment_key: entry.fragmentKey,
    heading_path: [...entry.headingPath],
    heading_level: entry.headingLevel,
  }));

  const blocked_section_ids = await resolveBlockedFragmentKeys(session, layout, currentProposalId);

  // Heading-key → fragment-key projection for the current topology. Reused to
  // resolve both the manifest claim set (FP5) and the editor focus set (FP6).
  const fragmentKeyByHeading = new Map<string, string>();
  for (const entry of layout) {
    fragmentKeyByHeading.set(SectionRef.headingKey(entry.headingPath), entry.fragmentKey);
  }

  // Bound-proposal claim set for the shared-draft banner (FP4/FP5): every section
  // target this in-flight proposal has claimed for THIS document — the exact set
  // finalization publishes. Sourced from the same manifest the publish path uses
  // (NOT inferred from pending state / canonical diffs), so the banner count and
  // the publish result cannot disagree. Each claim carries its heading path (for
  // display) and, when it still maps into the current topology, its fragment key.
  let bound_proposal_claimed_sections: WireClaimedSection[] = [];
  if (currentProposalId) {
    const { readActiveProposal } = await import("../storage/proposal-repository.js");
    const proposal = await readActiveProposal(currentProposalId);
    bound_proposal_claimed_sections = proposal.targets
      .filter((t): t is ProposalSectionTargetRef => t.kind === "section" && t.doc_path === session.docPath)
      .map((t) => {
        const headingPath = [...t.heading_path];
        const fragmentKey = fragmentKeyByHeading.get(SectionRef.headingKey(headingPath));
        return fragmentKey !== undefined
          ? { heading_path: headingPath, fragment_key: fragmentKey }
          : { heading_path: headingPath };
      });
  }

  // Editor-focus projection (FP6): each ATTACHED editor's focus target mapped onto
  // the current topology. Observers (null focus target) and targets that don't map
  // to a live fragment are excluded. Deduped so two editors on the same section
  // count once. Distinct from pending-writer state — the UI unions the two.
  const editor_focus_section_ids = [
    ...new Set(
      editorFocusStates
        .map((st) =>
          st.editorFocusTarget
            ? fragmentKeyByHeading.get(SectionRef.headingKey(sectionTargetToHeadingPath(st.editorFocusTarget)))
            : undefined,
        )
        .filter((k): k is string => k !== undefined),
    ),
  ];

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
    // The ONE evaluator, run on the current signals — the UI renders the exact
    // decision the runtime would make for this state (single source of truth).
    publish_decision: session.generator.publishTriggerPolicy.evaluate(
      buildCurrentPublishSignals(session, layout, editorFocusStates, Date.now()),
    ),
    bound_proposal_id: currentProposalId,
    bound_proposal_claimed_sections,
    editor_focus_section_ids,
  };
}

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
    claimScope: [session.docPath],
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
