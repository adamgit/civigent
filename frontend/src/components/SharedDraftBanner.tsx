import { useId, useState } from "react";
import type { ForcePublishOutcome } from "../services/api-client";

/** Gap between the bar's bottom edge and the top of the document footer. */
const BAR_BOTTOM_GAP_PX = 20;
/** Extra room kept between the editing caret and the bar's top edge. */
const CARET_CLEARANCE_GAP_PX = 8;

const SHARED_DRAFT_BAR_SELECTOR = ".shared-draft-bar";

/**
 * Bottom clearance the editor caret needs so it never scrolls under the floating
 * bar. Zero when no bar is mounted. Read live (like the sticky header offset)
 * because the bar comes and goes with the bound proposal.
 */
export function sharedDraftBarScrollClearancePx(): number {
  const bar = document.querySelector<HTMLElement>(SHARED_DRAFT_BAR_SELECTOR);
  if (!bar) return 0;
  return bar.offsetHeight + BAR_BOTTOM_GAP_PX + CARET_CLEARANCE_GAP_PX;
}

interface SharedDraftBannerProps {
  /** Sections the bound proposal has claimed (the manifest set finalization publishes). */
  changedSectionCount: number;
  /** True while a force-publish request is in flight. */
  forcePublishing: boolean;
  /** True while the live publish-pause mirror indicates a publish is already underway. */
  pauseActive: boolean;
  /** Most recent force-publish outcome to surface, or null when none issued yet. */
  lastOutcome: ForcePublishOutcome | null;
  onForcePublish: () => void;
}

function outcomeText(outcome: ForcePublishOutcome): { tone: "amber" | "red"; text: string } | null {
  switch (outcome.outcome) {
    case "committed":
      return null;
    case "noop":
      return { tone: "amber", text: outcome.message ?? "Nothing to publish right now." };
    case "aborted":
      return { tone: "amber", text: outcome.message ?? "Publish aborted — editors did not settle in time." };
    case "failed":
      return { tone: "red", text: outcome.message ? outcome.message : "Publish failed." };
  }
}

/**
 * Floating "shared draft" publish bar (FP7-FP11). Rendered by a document page
 * ONLY when the page has a live bound `inprogress` proposal. It floats over the
 * bottom of the document view (absolutely positioned against the page root), so
 * it never shifts document layout as it appears and disappears. A non-committed
 * force-publish outcome is shown inside the bar; a committed publish clears the
 * proposal, which removes the bar.
 */
export function SharedDraftBanner({
  changedSectionCount,
  forcePublishing,
  pauseActive,
  lastOutcome,
  onForcePublish,
}: SharedDraftBannerProps) {
  const [infoOpen, setInfoOpen] = useState(false);
  const infoId = useId();
  const busy = forcePublishing || pauseActive;
  const sectionWord = changedSectionCount === 1 ? "section" : "sections";
  const haveWord = changedSectionCount === 1 ? "has" : "have";
  const result = lastOutcome ? outcomeText(lastOutcome) : null;

  return (
    <div
      className="shared-draft-bar"
      style={{ bottom: `calc(var(--spacing-footer-h) + ${BAR_BOTTOM_GAP_PX}px)` }}
      role="status"
      aria-live="polite"
      data-testid="shared-draft-banner"
    >
      <div className="shared-draft-bar__row">
        <span className="shared-draft-bar__message">
          <strong>
            {changedSectionCount} {sectionWord}
          </strong>{" "}
          {haveWord} changes not yet visible to AI agents
        </span>
        <button
          type="button"
          className="shared-draft-bar__publish"
          disabled={busy}
          onClick={onForcePublish}
        >
          {busy ? "Publishing…" : "Publish now"}
        </button>
        <span
          className="shared-draft-bar__info-anchor"
          onMouseEnter={() => setInfoOpen(true)}
          onMouseLeave={() => setInfoOpen(false)}
        >
          <button
            type="button"
            className="shared-draft-bar__info"
            aria-label="About publishing"
            aria-describedby={infoOpen ? infoId : undefined}
            onFocus={() => setInfoOpen(true)}
            onBlur={() => setInfoOpen(false)}
          >
            i
          </button>
          {infoOpen ? (
            <div id={infoId} role="tooltip" className="shared-draft-bar__popover">
              <p className="shared-draft-bar__popover-lead">
                Publishing makes your edits visible to all AI agents immediately.
              </p>
              <p className="shared-draft-bar__popover-body">
                Alternatively, just close the tab or refresh the window — your edits publish then too.
              </p>
            </div>
          ) : null}
        </span>
      </div>
      {result ? (
        <div className={`shared-draft-bar__outcome shared-draft-bar__outcome--${result.tone}`}>
          {result.text}
        </div>
      ) : null}
    </div>
  );
}
