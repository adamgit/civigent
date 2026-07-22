export type SectionAttributionState =
  | "liveEditing"
  | "draftPending"
  | "recentlyEdited"
  | "settled"
  | "unknownWriter";

export interface SectionAttributionMeta {
  label: string;
  tone: string;
}

export const SECTION_ATTRIBUTION_META: Record<SectionAttributionState, SectionAttributionMeta> = {
  liveEditing: { label: "Editing now", tone: "text-text-primary" },
  draftPending: { label: "Draft edits here", tone: "text-text-muted italic" },
  recentlyEdited: { label: "Last edited", tone: "text-text-muted" },
  settled: { label: "Edited", tone: "text-text-muted" },
  unknownWriter: { label: "Unknown writer", tone: "text-error" },
};

export interface SectionAttributionInput {
  activeEditorIds: string[];
  secondsAgo: number | undefined;
  pending: boolean;
  writerType: string | undefined;
}

export function resolveSectionAttributionState(input: SectionAttributionInput): SectionAttributionState {
  const { activeEditorIds, secondsAgo, pending, writerType } = input;
  if (activeEditorIds.length > 0) return "liveEditing";
  if (pending) return "draftPending";
  if (writerType !== undefined && writerType !== "human" && writerType !== "agent") return "unknownWriter";
  if (secondsAgo !== undefined) return "recentlyEdited";
  return "settled";
}
