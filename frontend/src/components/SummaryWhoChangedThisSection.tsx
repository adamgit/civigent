import type { WriterType } from "../types/shared.js";
import { useAgeDisplay } from "../hooks/useAgeDisplay.js";
import { useSectionHover } from "../contexts/sectionHoverUtils.js";
import { resolveWriterId } from "../services/api-client.js";

interface Props {
  editorId: string | undefined;
  editorName: string | undefined;
  secondsAgo: number | undefined;
  writerType: WriterType | undefined;
  sectionIndex: number;
}

export function SummaryWhoChangedThisSection({ editorId, editorName, secondsAgo, writerType, sectionIndex }: Props) {
  const { hoveredSection, activeSectionIndex } = useSectionHover();
  const isVisible = hoveredSection === sectionIndex || activeSectionIndex === sectionIndex;
  const ageLabel = useAgeDisplay(secondsAgo);

  if (!isVisible || !editorName) return null;

  const isMe = editorId !== undefined && editorId === resolveWriterId();
  const displayName = isMe ? "[me]" : editorName;
  const isHuman = writerType !== "agent";
  const badgeLabel = isHuman ? "HUMAN" : "AI";

  return (
    <div className="text-[11px] text-text-muted leading-relaxed max-w-[200px] pr-2">
      <div className="font-medium text-text-primary truncate">{displayName}</div>
      {ageLabel && <div className="text-text-muted">{ageLabel}</div>}
      <span className={`inline-block mt-0.5 px-1.5 py-px rounded text-[10px] font-semibold ${isHuman ? "badge-human" : "badge-ai"}`}>
        {badgeLabel}
      </span>
    </div>
  );
}
