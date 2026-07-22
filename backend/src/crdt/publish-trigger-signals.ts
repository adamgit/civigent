import type { EditorFocusTarget } from "../types/shared.js";
import { sectionTargetToHeadingPath } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";
import type { DocSession } from "./ydoc-lifecycle.js";
import type { LiveSectionLayoutEntry } from "./live-section-layout.js";
import type { PublishTriggerSignals } from "./crdt-proposal-generator.js";

export interface EditorFocusState {
  editorFocusTarget: EditorFocusTarget | null;
}

export function buildQuiescencePublishSignals(
  session: DocSession,
  layout: LiveSectionLayoutEntry[],
  editorStates: readonly EditorFocusState[],
  observed: {
    allFragmentsQuiescent: boolean;
    structuralApplyInThisCommand: boolean;
    nowMs: number;
  },
): Omit<PublishTriggerSignals, "hasCurrentProposal"> {
  const dirty = session.dirtyFragmentKeys;
  const policy = session.generator.publishTriggerPolicy;

  const dirtyAndAdjacent = new Set<string>(dirty);
  layout.forEach((entry, i) => {
    if (!dirty.has(entry.fragmentKey)) return;
    if (i > 0) dirtyAndAdjacent.add(layout[i - 1].fragmentKey);
    if (i + 1 < layout.length) dirtyAndAdjacent.add(layout[i + 1].fragmentKey);
  });
  let noCollaboratorMutatingChangedSet = true;
  for (const key of dirtyAndAdjacent) {
    const last = session.fragmentLastActivity.get(key);
    if (last !== undefined && !policy.isFragmentQuiescent(last, observed.nowMs)) {
      noCollaboratorMutatingChangedSet = false;
      break;
    }
  }

  const fragmentKeyByHeading = new Map<string, string>();
  for (const entry of layout) {
    fragmentKeyByHeading.set(SectionRef.headingKey(entry.headingPath), entry.fragmentKey);
  }
  let usersLeftChangedSections = true;
  for (const st of editorStates) {
    if (!st.editorFocusTarget) continue;
    const focusKey = fragmentKeyByHeading.get(
      SectionRef.headingKey(sectionTargetToHeadingPath(st.editorFocusTarget)),
    );
    if (focusKey !== undefined && dirty.has(focusKey)) {
      usersLeftChangedSections = false;
      break;
    }
  }

  return {
    forcedCanonicalOperation: false,
    lastEditorLeft: false,
    allInboundUpdatesProcessed: true,
    noBurstOrCompositionInProgress: false,
    noTopologyChangeInFlight:
      observed.allFragmentsQuiescent && !observed.structuralApplyInThisCommand,
    usersLeftChangedSections,
    noCollaboratorMutatingChangedSet,
  };
}

/**
 * Build the CURRENT full `PublishTriggerSignals` for the document from real session
 * state — the same builder the autonomous-publish decision uses, plus the live
 * `allFragmentsQuiescent` observation and `hasCurrentProposal`. The wire assembler
 * runs this and feeds it through the ONE evaluator (`evaluate()`) so the decision it
 * ships to the UI is exactly the decision the runtime would make for this state.
 */
export function buildCurrentPublishSignals(
  session: DocSession,
  layout: LiveSectionLayoutEntry[],
  editorStates: readonly EditorFocusState[],
  nowMs: number,
): PublishTriggerSignals {
  const policy = session.generator.publishTriggerPolicy;
  let allFragmentsQuiescent = true;
  for (const [, lastActivity] of session.fragmentLastActivity) {
    if (!policy.isFragmentQuiescent(lastActivity, nowMs)) {
      allFragmentsQuiescent = false;
      break;
    }
  }
  const partial = buildQuiescencePublishSignals(session, layout, editorStates, {
    allFragmentsQuiescent,
    structuralApplyInThisCommand: false,
    nowMs,
  });
  return { ...partial, hasCurrentProposal: session.generator.hasCurrentProposal() };
}
