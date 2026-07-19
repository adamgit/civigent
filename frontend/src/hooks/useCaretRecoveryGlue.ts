import { useMemo, useRef } from "react";
import type { EditorView } from "@milkdown/prose/view";
import {
  captureCaretBeforeStructuralApply,
  recoverCaret,
  type CaretFrameHooks,
  type CaretRecovery,
} from "../pages/caret-recovery";

export interface CaretGlueConfig {
  editorMode: boolean;
  focusedFragmentKey: string | null;
  getView: (fragmentKey: string) => EditorView | null;
  onRetarget: (recovery: Extract<CaretRecovery, { kind: "retarget" }>) => void;
}

export interface UseCaretRecoveryGlueReturn {
  lastCaretRecoveryRef: React.MutableRefObject<CaretRecovery | null>;
  configRef: React.MutableRefObject<CaretGlueConfig | null>;
  caretFrameHooks: CaretFrameHooks;
}

export function useCaretRecoveryGlue(): UseCaretRecoveryGlueReturn {
  const lastCaretRecoveryRef = useRef<CaretRecovery | null>(null);
  const configRef = useRef<CaretGlueConfig | null>(null);

  const caretFrameHooks = useMemo<CaretFrameHooks>(
    () => ({
      beforeApply: () => {
        const cfg = configRef.current;
        if (!cfg || !cfg.editorMode || !cfg.focusedFragmentKey) return null;
        const view = cfg.getView(cfg.focusedFragmentKey);
        if (!view) return null;
        return captureCaretBeforeStructuralApply(cfg.focusedFragmentKey, view);
      },
      afterApply: (capture, prevTopology, nextTopology, ydoc) => {
        const recovery = recoverCaret({ capture, prevTopology, nextTopology, ydoc });
        if (!recovery) return;
        lastCaretRecoveryRef.current = recovery;
        if (recovery.kind === "retarget") {
          configRef.current?.onRetarget(recovery);
        }
      },
    }),
    [],
  );

  return { lastCaretRecoveryRef, configRef, caretFrameHooks };
}
