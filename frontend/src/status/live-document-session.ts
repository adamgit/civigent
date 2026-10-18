import type { LiveSectionRef } from "../types/live-sections";
import { SectionId } from "../types/live-sections";
import type { SplitCaretPlacement } from "../pages/split-caret";
import { resolveFocusAfterTopologyChange } from "../pages/resolve-focus-after-topology-change";
import { shouldMountEditorForFragment } from "../pages/document-page-utils";

export interface ViewPipe {
  phase: "connecting" | "live" | "reconnecting";
}

export interface EditPipe {
  phase: ViewPipe["phase"] | "error";
}

export type LiveDocumentSession =
  | { readonly kind: "viewing"; readonly pipe: ViewPipe; readonly paused: boolean }
  | { readonly kind: "editing"; readonly pipe: EditPipe; readonly paused: boolean; readonly section: SectionId };

export function viewing(pipe: ViewPipe, paused: boolean): LiveDocumentSession {
  return { kind: "viewing", pipe, paused };
}

export function editing(section: SectionId, pipe: EditPipe, paused: boolean): LiveDocumentSession {
  return { kind: "editing", pipe, paused, section };
}

export type Placement =
  | { coords: { x: number; y: number } }
  | { at: "start" | "end"; column: number | null }
  | { retarget: SplitCaretPlacement };

export type ClickCoords = { x: number; y: number };

export type SessionCommand =
  | { type: "openEditor"; section: SectionId; coords: ClickCoords }
  | { type: "moveCaretToPoint"; section: SectionId; coords: ClickCoords }
  | { type: "moveCaretToEdge"; section: SectionId; edge: "start" | "end"; column: number | null }
  | { type: "retargetCaret"; section: SectionId; retarget: SplitCaretPlacement }
  | { type: "stopEditing"; cause?: "socket-stopped" }
  | { type: "pipeChanged"; pipe: EditPipe }
  | { type: "sessionReplaced"; keepEditing: boolean }
  | { type: "superseded" }
  | { type: "sessionEnded" }
  | { type: "pauseChanged"; paused: boolean }
  | { type: "topologyChanged"; prev: readonly LiveSectionRef[]; next: readonly LiveSectionRef[] };

const CONNECTING: ViewPipe = { phase: "connecting" };

function viewPipeFromEditPipe(pipe: EditPipe): ViewPipe {
  return pipe.phase === "error" ? { phase: "reconnecting" } : { phase: pipe.phase };
}

export function reduceSession(prev: LiveDocumentSession, cmd: SessionCommand): LiveDocumentSession {
  switch (cmd.type) {
    case "openEditor":
      if (prev.kind === "editing") return prev;
      return editing(cmd.section, CONNECTING, prev.paused);
    case "moveCaretToPoint":
    case "moveCaretToEdge":
    case "retargetCaret":
      if (prev.kind === "viewing") return prev;
      return editing(cmd.section, prev.pipe, prev.paused);
    case "stopEditing":
    case "superseded":
      if (prev.kind === "editing") return viewing(CONNECTING, prev.paused);
      return prev;
    case "sessionEnded":
      return viewing(CONNECTING, prev.paused);
    case "sessionReplaced":
      if (cmd.keepEditing && prev.kind === "editing") return editing(prev.section, CONNECTING, prev.paused);
      return viewing(CONNECTING, prev.paused);
    case "pipeChanged":
      if (prev.kind === "editing") return editing(prev.section, cmd.pipe, prev.paused);
      if (cmd.pipe.phase === "error") {
        throw new Error(`reduceSession: a viewing session cannot receive pipe phase "error" (prev: ${JSON.stringify(prev)})`);
      }
      return viewing({ phase: cmd.pipe.phase }, prev.paused);
    case "pauseChanged":
      if (prev.kind === "editing") return editing(prev.section, prev.pipe, cmd.paused);
      return viewing(prev.pipe, cmd.paused);
    case "topologyChanged": {
      if (prev.kind === "viewing") return prev;
      const survivor = resolveFocusAfterTopologyChange(cmd.prev, cmd.next, prev.section);
      if (survivor === null) return viewing(viewPipeFromEditPipe(prev.pipe), prev.paused);
      if (survivor === prev.section) return prev;
      return editing(survivor, prev.pipe, prev.paused);
    }
  }
}

export function focusedSection(s: LiveDocumentSession): SectionId | null {
  return s.kind === "editing" ? s.section : null;
}

export type ActivateRow =
  | { type: "openEditor"; section: SectionId; coords: ClickCoords }
  | { type: "moveCaretToPoint"; section: SectionId; coords: ClickCoords };

export function onActivateRow(
  s: LiveDocumentSession,
  row: SectionId,
  coords: ClickCoords,
  blocked: boolean,
): ActivateRow | null {
  if (s.paused || blocked) return null;
  if (s.kind === "viewing") return { type: "openEditor", section: row, coords };
  return { type: "moveCaretToPoint", section: row, coords };
}

export function rowReadOnly(s: LiveDocumentSession, row: SectionId, blocked: boolean): boolean {
  return s.kind !== "editing" || s.section !== row || s.paused || blocked || s.pipe.phase !== "live";
}

export function mountEditor(
  s: LiveDocumentSession,
  row: SectionId,
  orderedKeys: readonly string[],
  focusedReady: boolean,
): boolean {
  return s.kind === "editing"
    && shouldMountEditorForFragment(SectionId.text(row), SectionId.text(s.section), orderedKeys, focusedReady);
}
