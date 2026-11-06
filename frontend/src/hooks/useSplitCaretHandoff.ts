import { useMemo, useRef } from "react";
import type { EditorView } from "@milkdown/prose/view";
import type * as Y from "yjs";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import {
  appendedChunkBodyOffset,
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
  readFragment: (fragmentKey: string) => Y.XmlFragment | null;
  onRetarget: (
    plan: Extract<SplitCaretPlan, { action: "follow-promotion" | "follow-predecessor" }>,
  ) => void;
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
  configRef: React.MutableRefObject<SplitCaretHandoffConfig | null>;
  caretFrameHooks: CaretFrameHooks;
}

export function useSplitCaretHandoff(): UseSplitCaretHandoffReturn {
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
        if (plan.action !== "follow-promotion" && plan.action !== "follow-predecessor") return;
        if (plan.action === "follow-predecessor") {
          const cfg = configRef.current;
          const sourceView = cfg?.getView(capture.sourceFragmentKey);
          if (!cfg || !sourceView) return;
          const sourceFragment = cfg.readFragment(capture.sourceFragmentKey);
          const predecessorFragment = cfg.readFragment(plan.fragmentKey);
          if (!sourceFragment || !predecessorFragment) return;
          let sourceDoc;
          let predecessorDoc;
          try {
            sourceDoc = yXmlFragmentToProseMirrorRootNode(sourceFragment, sourceView.state.schema);
            predecessorDoc = yXmlFragmentToProseMirrorRootNode(predecessorFragment, sourceView.state.schema);
          } catch {
            return;
          }
          const offset = appendedChunkBodyOffset(sourceDoc, predecessorDoc, plan.chunk, plan.offset);
          if (offset === null) return;
          sealEditorForCaretTransit(sourceView);
          cfg.onRetarget({ ...plan, offset });
          return;
        }
        const sourceView = configRef.current?.getView(capture.sourceFragmentKey);
        if (sourceView) sealEditorForCaretTransit(sourceView);
        configRef.current?.onRetarget(plan);
      },
    }),
    [],
  );

  return { configRef, caretFrameHooks };
}
