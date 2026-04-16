import { useAgeDisplay } from "../hooks/useAgeDisplay.js";
import { useSectionHover } from "../contexts/sectionHoverUtils.js";
import { resolveWriterId } from "../services/api-client.js";

interface Props {
  editorId: string | undefined;
  editorName: string | undefined;
  secondsAgo: number | undefined;
  writerType: string | undefined;
  sectionIndex: number;
}

export function SummaryWhoChangedThisSection({ editorId, editorName, secondsAgo, writerType, sectionIndex }: Props) {
  const { hoveredSection, activeSectionIndex } = useSectionHover();
  const isVisible = hoveredSection === sectionIndex || activeSectionIndex === sectionIndex;
  const ageLabel = useAgeDisplay(secondsAgo);

  if (!isVisible) return null;

  const hasAnyAttribution = editorId !== undefined || editorName !== undefined || writerType !== undefined;

  const isHuman = writerType === "human";
  const isAgent = writerType === "agent";
  const isUnknown = !isHuman && !isAgent;

  // Degraded rendering contract:
  // - missing writerType → visible UNKNOWN badge
  // - missing display name but known writer id → stable fallback label from id
  // - missing both name and id → visible attribution error state
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

  const badgeLabel = isHuman ? "HUMAN" : isAgent ? "AI" : "UNKNOWN";
  const rawWriterType = writerType ?? "(missing)";

  return (
    <div className="section-who-changed-anchor">
      <div className="section-who-changed">
        <div className={`section-who-changed-name ${isUnknown ? "text-error" : "text-text-primary"}`}>{displayName}</div>
        <div className="section-who-changed-meta">
          {ageLabel ? <div className="section-who-changed-age text-text-muted">{ageLabel}</div> : null}
          <div className="section-who-changed-type-line">
            <span
              className={`inline-block px-1.5 py-px rounded text-[10px] font-semibold ${
                isHuman ? "badge-human" : isAgent ? "badge-ai" : "text-error border border-current"
              }`}
            >
              {badgeLabel}
            </span>
            {isUnknown ? (
              <span className="section-who-changed-raw text-error cursor-help" title={`Raw backend writer type: ${rawWriterType}`} tabIndex={0}>
                (raw: {rawWriterType})
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
