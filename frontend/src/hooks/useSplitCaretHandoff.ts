import { useMemo, useRef } from "react";
import type { EditorView } from "@milkdown/prose/view";
import {
  captureCaretBeforeStructuralApply,
  planCaretAfterSplit,
  sealEditorForCaretTransit,
  type CaretFrameHooks,
  type SplitCaretPlan,
  type SplitSurvivorIdentity,
} from "../pages/split-caret";
import { SectionId, type LiveSectionRef } from "../types/live-sections";

export interface SplitCaretHandoffConfig {
  editorMode: boolean;
  focusedFragmentKey: string | null;
  topology: readonly LiveSectionRef[];
  getView: (fragmentKey: string) => EditorView | null;
  onRetarget: (plan: Extract<SplitCaretPlan, { action: "follow-promotion" }>) => void;
}

function survivorIdentityFor(
  topology: readonly LiveSectionRef[],
  fragmentKey: string,
): SplitSurvivorIdentity | null {
  const row = topology.find((r) => SectionId.text(r.id) === fragmentKey);
  if (!row || row.headingPath.length === 0) return null;
  return {
    heading: row.headingPath[row.headingPath.length - 1]!,
    headingLevel: Number(row.headingLevel),
  };
}

export interface UseSplitCaretHandoffReturn {
  lastCaretRecoveryRef: React.MutableRefObject<SplitCaretPlan | null>;
  configRef: React.MutableRefObject<SplitCaretHandoffConfig | null>;
  caretFrameHooks: CaretFrameHooks;
}

export function useSplitCaretHandoff(): UseSplitCaretHandoffReturn {
  const lastCaretRecoveryRef = useRef<SplitCaretPlan | null>(null);
  const configRef = useRef<SplitCaretHandoffConfig | null>(null);

  const caretFrameHooks = useMemo<CaretFrameHooks>(
    () => ({
      beforeApply: () => {
        const cfg = configRef.current;
        if (!cfg || !cfg.editorMode || !cfg.focusedFragmentKey) return null;
        const view = cfg.getView(cfg.focusedFragmentKey);
        if (!view) return null;
        return captureCaretBeforeStructuralApply(
          cfg.focusedFragmentKey,
          view,
          survivorIdentityFor(cfg.topology, cfg.focusedFragmentKey),
        );
      },
      afterApply: (capture, prevTopology, nextTopology) => {
        if (!capture) return;
        const plan = planCaretAfterSplit({
          location: capture.location,
          sourceFragmentKey: capture.sourceFragmentKey,
          fingerprint: capture.fingerprint,
          prevTopology,
          nextTopology,
        });
        if (!plan) return;
        lastCaretRecoveryRef.current = plan;
        if (plan.action === "follow-promotion") {
          const sourceView = configRef.current?.getView(capture.sourceFragmentKey);
          if (sourceView) sealEditorForCaretTransit(sourceView);
          configRef.current?.onRetarget(plan);
        }
      },
    }),
    [],
  );

  return { lastCaretRecoveryRef, configRef, caretFrameHooks };
}
