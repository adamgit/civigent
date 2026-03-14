import type { DocPath, HeadingPath } from "../../types/shared.js";

export interface ProposalDescriptionState {
  proposalId: string;
  intent: string;
  autoUpdateDescription: boolean;
}

export interface EditorSessionState {
  docPath: DocPath;
  activeHeadingPath: HeadingPath | null;
  proposal: ProposalDescriptionState | null;
  hasUnsavedChanges: boolean;
  structuralIntentMarked: boolean;
}
