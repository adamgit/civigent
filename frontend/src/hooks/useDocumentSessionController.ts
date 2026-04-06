import { useMemo } from "react";
import { DocumentSessionController } from "../controllers/document-session-controller";
import {
  getSectionFragmentKey,
  type DocumentSection,
} from "../pages/document-page-utils";
import { sectionHeadingKey, type ContentCommittedEvent } from "../types/shared.js";
import {
  useDocumentCrdt,
  type UseDocumentCrdtParams,
  type UseDocumentCrdtReturn,
} from "./useDocumentCrdt";

export interface UseDocumentSessionControllerReturn extends UseDocumentCrdtReturn {
  sessionController: DocumentSessionController;
}

function findSectionIndexByFragmentKey(
  sections: DocumentSection[],
  fragmentKey: string,
): number {
  return sections.findIndex((section) => getSectionFragmentKey(section) === fragmentKey);
}

export function useDocumentSessionController(
  params: UseDocumentCrdtParams,
): UseDocumentSessionControllerReturn {
  const runtime = useDocumentCrdt(params);

  const sessionController = useMemo(() => new DocumentSessionController({
    connectObserver: async () => {
      await runtime.requestMode("observer");
    },
    leaveSession: async () => {
      await runtime.requestMode("none");
    },
    enterEdit: async ({ index, coords }) => {
      await runtime.startEditing(index, coords);
    },
    focusSection: ({ index, headingPath, coords }) => {
      runtime.setFocusedSectionIndex(index);
      runtime.pendingFocusRef.current = { index, position: "start", coords };
      const provider = runtime.crdtProviderRef.current;
      if (provider) {
        provider.focusSection(headingPath);
        runtime.setViewingSections(provider, index);
      }
    },
    moveFocus: (direction) => {
      const focused = runtime.focusedSectionIndexRef.current;
      if (focused == null) return;
      runtime.handleCursorExit(focused, direction);
    },
    flushNow: () => {
      runtime.crdtProviderRef.current?.sendFlushRequest();
    },
    registerEditor: (fragmentKey, handle) => {
      const idx = findSectionIndexByFragmentKey(params.sections, fragmentKey);
      if (idx >= 0) {
        runtime.setEditorRef(idx, handle);
      }
    },
    markEditorReady: (fragmentKey) => {
      const idx = findSectionIndexByFragmentKey(params.sections, fragmentKey);
      if (idx < 0) return;
      runtime.setReadyEditors((prev) => {
        const next = new Set(prev);
        next.add(idx);
        return next;
      });
    },
    markEditorUnready: (fragmentKey) => {
      const idx = findSectionIndexByFragmentKey(params.sections, fragmentKey);
      if (idx < 0) return;
      runtime.setReadyEditors((prev) => {
        if (!prev.has(idx)) return prev;
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
    },
    applySectionsRefresh: (sections) => {
      params.setSections(sections);
    },
    handleStructureChanged: (sections) => {
      params.setSections(sections);
    },
    handleCommittedSections: (event: ContentCommittedEvent) => {
      const committedHeadingKeys = new Set(event.sections.map((s) => sectionHeadingKey(s.heading_path)));
      runtime.setSectionPersistence((prev) => {
        const next = new Map(prev);
        for (const section of params.sections) {
          if (committedHeadingKeys.has(sectionHeadingKey(section.heading_path))) {
            next.delete(getSectionFragmentKey(section));
          }
        }
        return next;
      });
    },
  }), [
    params.sections,
    params.setSections,
    runtime,
  ]);

  return {
    ...runtime,
    sessionController,
  };
}

