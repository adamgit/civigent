/**
 * TEMP debug overlay — leftover-focus observer lock probe.
 *
 * The original lock was: viewing + leftover focused section + a mounted
 * Milkdown frozen by unused-editor `disconnected`. This session model cannot
 * hold leftover focus (`focusedSection` is null while viewing). The button
 * still runs the old recipe (stop editing, then inject a page-level leftover
 * stripe) so we can see whether that stripe can freeze click-to-edit.
 *
 * Delete this file (and `frontend/src/debug/`) plus the import and JSX mount
 * in DocumentPage.tsx when bug testing is done.
 */

import type { CSSProperties } from "react";
import type { LiveDocumentSession } from "../status/live-document-session";
import {
  focusedSection,
  mountEditor,
  onActivateRow,
  rowReadOnly,
} from "../status/live-document-session";
import { SectionId } from "../types/live-sections";

export interface LeftoverFocusLockTriggerProps {
  session: LiveDocumentSession;
  bound: boolean;
  focusedFragmentKey: string | null;
  firstSectionId: SectionId | null;
  orderedFragmentKeys: readonly string[];
  focusedEditorReady: boolean;
  leftoverFragmentKey: string | null;
  stopEditing: () => void;
  injectLeftoverFocus: (fragmentKey: string) => void;
  clearLeftoverFocus: () => void;
}

const panelStyle: CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 40,
  zIndex: 80,
  width: 300,
  padding: "10px 12px",
  background: "#1f1220",
  color: "#fde68a",
  border: "2px solid #f472b6",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  lineHeight: 1.45,
  pointerEvents: "auto",
};

const buttonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 8,
  padding: "6px 8px",
  border: "1px solid #f472b6",
  borderRadius: 4,
  background: "#831843",
  color: "#fff",
  font: "inherit",
  fontWeight: 700,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "transparent",
  color: "#fde68a",
};

export function LeftoverFocusLockTrigger({
  session,
  bound,
  focusedFragmentKey,
  firstSectionId,
  orderedFragmentKeys,
  focusedEditorReady,
  leftoverFragmentKey,
  stopEditing,
  injectLeftoverFocus,
  clearLeftoverFocus,
}: LeftoverFocusLockTriggerProps) {
  const derivedFocus = focusedSection(session);
  const wouldMount = firstSectionId !== null
    && mountEditor(session, firstSectionId, orderedFragmentKeys, focusedEditorReady);
  const activate = firstSectionId === null
    ? null
    : onActivateRow(session, firstSectionId, { x: 0, y: 0 }, false);
  const firstRowReadOnly = firstSectionId !== null && rowReadOnly(session, firstSectionId, false);
  const lockPossible = session.kind === "viewing" && leftoverFragmentKey !== null && wouldMount;

  const enterLock = () => {
    if (session.kind === "editing") stopEditing();
    if (!firstSectionId) return;
    injectLeftoverFocus(SectionId.text(firstSectionId));
  };

  return (
    <div style={panelStyle} data-testid="temp-leftover-focus-lock-trigger">
      <div style={{ fontWeight: 800, letterSpacing: "0.04em", color: "#f472b6" }}>
        TEMP — leftover-focus lock
      </div>
      <div style={{ marginTop: 6, color: "#fbcfe8" }}>
        <div>kind: {session.kind}</div>
        <div>pipe: {session.pipe.phase}</div>
        <div>paused: {String(session.paused)}</div>
        <div>bound: {String(bound)}</div>
        <div>derivedFocus: {derivedFocus ? SectionId.text(derivedFocus) : "null"}</div>
        <div>injectedLeftover: {leftoverFragmentKey ?? "null"}</div>
        <div>focused: {focusedFragmentKey ?? "null"}</div>
        <div>wouldMountEditor: {String(wouldMount)}</div>
        <div>firstRowReadOnly: {String(firstRowReadOnly)}</div>
        <div>click: {activate ? activate.type : "ignored"}</div>
        <div style={{ marginTop: 4, color: lockPossible ? "#fda4af" : "#86efac" }}>
          lock: {lockPossible ? "POSSIBLE" : "cannot form"}
        </div>
      </div>
      <button type="button" style={buttonStyle} disabled={!firstSectionId} onClick={enterLock}>
        Attempt leftover-focus lock
      </button>
      <button type="button" style={secondaryButtonStyle} onClick={clearLeftoverFocus}>
        Clear leftover focus
      </button>
    </div>
  );
}
