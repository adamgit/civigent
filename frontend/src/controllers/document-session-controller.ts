import type { MilkdownEditorHandle } from "../components/MilkdownEditor";
import type { ContentCommittedEvent } from "../types/shared.js";
import type { DocumentSection } from "../pages/document-page-utils";

export interface SectionFocusParams {
  fragmentKey: string;
  headingPath: string[];
  index: number;
  coords?: { x: number; y: number };
}

export interface DocumentSessionControllerDeps {
  connectObserver: () => Promise<void>;
  leaveSession: () => Promise<void>;
  enterEdit: (params: SectionFocusParams) => Promise<void>;
  focusSection: (params: SectionFocusParams) => void;
  moveFocus: (direction: "up" | "down") => void;
  importToSessionOverlayNow: () => void;
  registerEditor: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  markEditorReady: (fragmentKey: string) => void;
  markEditorUnready: (fragmentKey: string) => void;
  applySectionsRefresh: (sections: DocumentSection[]) => void;
  handleStructureChanged: (sections: DocumentSection[]) => void;
  handleCommittedSections: (event: ContentCommittedEvent) => void;
}

/**
 * Frontend runtime owner façade for document session commands.
 * Command implementation is injected so the class can remain framework-agnostic.
 */
export class DocumentSessionController {
  constructor(private readonly deps: DocumentSessionControllerDeps) {}

  connectObserver(): Promise<void> {
    return this.deps.connectObserver();
  }

  leaveSession(): Promise<void> {
    return this.deps.leaveSession();
  }

  enterEdit(params: SectionFocusParams): Promise<void> {
    return this.deps.enterEdit(params);
  }

  focusSection(params: SectionFocusParams): void {
    this.deps.focusSection(params);
  }

  moveFocus(direction: "up" | "down"): void {
    this.deps.moveFocus(direction);
  }

  importToSessionOverlayNow(): void {
    this.deps.importToSessionOverlayNow();
  }

  registerEditor(fragmentKey: string, handle: MilkdownEditorHandle | null): void {
    this.deps.registerEditor(fragmentKey, handle);
  }

  markEditorReady(fragmentKey: string): void {
    this.deps.markEditorReady(fragmentKey);
  }

  markEditorUnready(fragmentKey: string): void {
    this.deps.markEditorUnready(fragmentKey);
  }

  applySectionsRefresh(sections: DocumentSection[]): void {
    this.deps.applySectionsRefresh(sections);
  }

  handleStructureChanged(sections: DocumentSection[]): void {
    this.deps.handleStructureChanged(sections);
  }

  handleCommittedSections(event: ContentCommittedEvent): void {
    this.deps.handleCommittedSections(event);
  }
}

