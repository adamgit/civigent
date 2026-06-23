/**
 * Shared initial-load observer guard for DocumentPage / GovernanceDocumentPage:
 * load canonical sections, then start observer mode unless edit mode is already
 * requested. Deduplicates an identical inline effect that existed in both pages.
 */

import { useEffect } from "react";
import type {
  DocumentSessionControllerState,
  EditorFocusTarget,
  RequestedMode,
} from "../types/shared.js";
import type { DocumentSection } from "../pages/document-page-utils";

export interface UseInitialObserverGuardParams {
  decodedDocPath: string | null;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  requestMode: (mode: RequestedMode, focusTarget?: EditorFocusTarget | null) => Promise<void>;
  stopObserver: () => void;
  controllerStateRef: React.MutableRefObject<DocumentSessionControllerState>;
}

export function useInitialObserverGuard({
  decodedDocPath,
  loadSections,
  requestMode,
  stopObserver,
  controllerStateRef,
}: UseInitialObserverGuardParams): void {
  useEffect(() => {
    if (!decodedDocPath) return;
    let cancelled = false;
    loadSections(decodedDocPath).then(() => {
      if (cancelled) return;
      if (controllerStateRef.current.requestedMode !== "editor") requestMode("observer");
    });
    return () => {
      cancelled = true;
      stopObserver();
    };
  }, [decodedDocPath, loadSections, requestMode, stopObserver, controllerStateRef]);
}
