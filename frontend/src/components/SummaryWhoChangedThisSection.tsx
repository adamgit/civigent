import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAgeDisplay } from "../hooks/useAgeDisplay.js";
import { useSectionHover } from "../contexts/sectionHoverUtils.js";
import { resolveWriterId } from "../services/api-client.js";
import {
  resolveSectionAttributionState,
  SECTION_ATTRIBUTION_META,
} from "../services/section-attribution-state.js";
import { PublishRequirementsHover } from "./PublishRequirementsHover.js";
import type { PublishTriggerDecision } from "../types/shared.js";

interface Props {
  editorId: string | undefined;
  editorName: string | undefined;
  secondsAgo: number | undefined;
  writerType: string | undefined;
  fragmentKey: string;
  uncommittedChanges?: boolean;
  activeEditorIds?: string[];
  publishDecision?: PublishTriggerDecision | null;
}

export function SummaryWhoChangedThisSection({
  editorId,
  editorName,
  secondsAgo,
  writerType,
  fragmentKey,
  uncommittedChanges = false,
  activeEditorIds = [],
  publishDecision = null,
}: Props) {
  const { hoveredFragmentKey, activeFragmentKey } = useSectionHover();
  const isVisible = hoveredFragmentKey === fragmentKey || activeFragmentKey === fragmentKey;
  const ageLabel = useAgeDisplay(secondsAgo);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoCoords, setInfoCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const openInfo = () => {
    const el = triggerRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setInfoCoords({ top: rect.bottom + 6, left: Math.max(8, rect.right - 280) });
    }
    setInfoOpen(true);
  };
  const closeInfo = () => setInfoOpen(false);

  if (!isVisible) return null;

  const state = resolveSectionAttributionState({
    activeEditorIds,
    secondsAgo,
    pending: uncommittedChanges,
    writerType,
  });
  const meta = SECTION_ATTRIBUTION_META[state];

  const hasAnyAttribution = editorId !== undefined || editorName !== undefined || writerType !== undefined;
  const isHuman = writerType === "human";
  const isAgent = writerType === "agent";
  const badgeLabel = isHuman ? "HUMAN" : isAgent ? "AI" : "UNKNOWN";
  const badgeClass = isHuman ? "badge-human" : isAgent ? "badge-ai" : "text-error border border-current";

  if (state === "draftPending") {
    return (
      <div className="section-who-changed-anchor">
        <div
          ref={triggerRef}
          className="section-who-changed relative cursor-help"
          data-testid="draft-info-affordance"
          tabIndex={0}
          aria-label="What does this mean?"
          onMouseEnter={openInfo}
          onMouseLeave={closeInfo}
          onFocus={openInfo}
          onBlur={closeInfo}
        >
          <div className={`section-who-changed-name ${meta.tone}`}>
            {meta.label}
            <span className="section-who-changed-info" aria-hidden="true">ⓘ</span>
          </div>
          {hasAnyAttribution ? (
            <div className="section-who-changed-meta">
              <div className="section-who-changed-type-line">
                <span className={`inline-block px-1.5 py-px rounded text-[10px] font-semibold ${badgeClass}`}>
                  {badgeLabel}
                </span>
              </div>
              {ageLabel ? <div className="section-who-changed-age text-text-muted">{ageLabel}</div> : null}
            </div>
          ) : null}
          {infoOpen && infoCoords
            ? createPortal(
                <PublishRequirementsHover
                  decision={publishDecision}
                  style={{ top: infoCoords.top, left: infoCoords.left }}
                  what="Your recent edits to this section are saved as a draft. They haven't been published to the shared document yet."
                  why="Editing here is still settling, so this part is held as a draft until it's safe to publish."
                />,
                document.body,
              )
            : null}
        </div>
      </div>
    );
  }

  const isUnknown = state === "unknownWriter";
  const rawWriterType = writerType ?? "(missing)";

  let displayName: string;
  if (editorId !== undefined && editorId === resolveWriterId()) {
    displayName = "[me]";
  } else if (editorName) {
    displayName = editorName;
  } else if (editorId) {
    displayName = editorId;
  } else if (hasAnyAttribution) {
    displayName = "(unknown writer)";
  } else {
    displayName = "(no attribution)";
  }

  const statusLabel = state === "recentlyEdited" ? ageLabel : meta.label;

  return (
    <div className="section-who-changed-anchor">
      <div className="section-who-changed">
        <div className={`section-who-changed-name ${isUnknown ? "text-error" : "text-text-primary"}`}>{displayName}</div>
        <div className="section-who-changed-meta">
          <div className="section-who-changed-type-line">
            <span className={`inline-block px-1.5 py-px rounded text-[10px] font-semibold ${badgeClass}`}>
              {badgeLabel}
            </span>
            {isUnknown ? (
              <span className="section-who-changed-raw text-error cursor-help" title={`Raw backend writer type: ${rawWriterType}`} tabIndex={0}>
                (raw: {rawWriterType})
              </span>
            ) : null}
          </div>
          {statusLabel ? <div className={`section-who-changed-age ${meta.tone}`}>{statusLabel}</div> : null}
        </div>
      </div>
    </div>
  );
}
