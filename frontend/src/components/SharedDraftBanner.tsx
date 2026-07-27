import type { ForcePublishOutcome } from "../services/api-client";

interface SharedDraftBannerProps {
  /** Sections the bound proposal has claimed (the manifest set finalization publishes). */
  changedSectionCount: number;
  /** Sections with a live writer editing right now (subset of the changed set). */
  activelyEditedCount: number;
  /** True while a force-publish request is in flight. */
  forcePublishing: boolean;
  /** True while the live publish-pause mirror indicates a publish is already underway. */
  pauseActive: boolean;
  /** Most recent force-publish outcome to surface, or null when none issued yet. */
  lastOutcome: ForcePublishOutcome | null;
  onForcePublish: () => void;
}

function outcomeText(outcome: ForcePublishOutcome): { tone: "green" | "amber" | "red"; text: string } {
  switch (outcome.outcome) {
    case "committed":
      return { tone: "green", text: outcome.message ?? "Published to canonical." };
    case "noop":
      return { tone: "amber", text: outcome.message ?? "Nothing to publish right now." };
    case "aborted":
      return { tone: "amber", text: outcome.message ?? "Publish aborted — editors did not settle in time." };
    case "failed":
      return { tone: "red", text: outcome.message ? `Publish failed: ${outcome.message}` : "Publish failed." };
  }
}

const TONE_CLASS: Record<"green" | "amber" | "red", string> = {
  green: "text-status-green",
  amber: "text-amber-700",
  red: "text-status-red",
};

/**
 * Top-of-document "shared draft" banner (FP7-FP11). Rendered by a document page
 * ONLY when the page has a live bound `inprogress` proposal, so its mere presence
 * signals "this document has unpublished shared draft edits". Shows the changed /
 * actively-edited counts, a force-publish action, its pending state, and the last
 * outcome. The banner is retained across an aborted/failed publish because the
 * page keeps rendering it while the proposal remains in progress.
 */
export function SharedDraftBanner({
  changedSectionCount,
  activelyEditedCount,
  forcePublishing,
  pauseActive,
  lastOutcome,
  onForcePublish,
}: SharedDraftBannerProps) {
  const busy = forcePublishing || pauseActive;
  const sectionWord = changedSectionCount === 1 ? "section" : "sections";
  const buttonLabel = forcePublishing
    ? "Publishing…"
    : pauseActive
      ? "Publishing…"
      : `Force publish ${changedSectionCount} ${sectionWord}`;

  const result = lastOutcome ? outcomeText(lastOutcome) : null;

  return (
    <div
      className="flex items-center gap-3 flex-wrap border border-accent-border bg-accent-light px-4 py-2 rounded-sm text-xs"
      role="status"
      aria-live="polite"
      data-testid="shared-draft-banner"
    >
      <span className="font-medium text-accent-text">
        Shared draft — {changedSectionCount} changed {sectionWord}
        {activelyEditedCount > 0
          ? `, ${activelyEditedCount} being edited now`
          : ""}
      </span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={busy}
        onClick={onForcePublish}
        title={`Publish all ${changedSectionCount} changed ${sectionWord} now, including any still being edited`}
      >
        {buttonLabel}
      </button>
      {/* FP20: make the full-batch semantics explicit — this publishes the whole
          proposal, not a selected section or a refresh. */}
      <span className="w-full text-[11px] text-accent-text/80">
        Force publishing commits all {changedSectionCount} changed {sectionWord} in this draft
        {activelyEditedCount > 0 ? ", including work being edited right now" : ""}.
      </span>
      {result ? (
        <span className={`w-full ${TONE_CLASS[result.tone]}`}>{result.text}</span>
      ) : null}
    </div>
  );
}
