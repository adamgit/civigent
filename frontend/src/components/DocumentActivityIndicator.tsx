/**
 * DocumentActivityIndicator — floating top-center pill that signals the document
 * is settling, driven by `useDocumentActivity`. Communicates activity, never
 * denial — no lock/disabled affordance. The wording splits YOUR save from an
 * inbound update: a local commit reads "Saving… → Saved", an inbound update reads
 * "Updating… → Up to date". Styles + keyframes live in styles.css under
 * "Document activity indicator".
 */

import { useEffect, useState } from "react";
import type { DocumentActivityState } from "../hooks/useDocumentActivity";

export function DocumentActivityIndicator({ activity }: { activity: DocumentActivityState }) {
  // Keep the last non-idle content mounted through the fade-out so exit animates.
  const [content, setContent] = useState<DocumentActivityState>(activity);
  useEffect(() => {
    if (activity.phase !== "idle") {
      setContent(activity);
      return;
    }
    const t = setTimeout(() => setContent(activity), 320);
    return () => clearTimeout(t);
  }, [activity]);

  const visible = activity.phase !== "idle";
  const isLocal = content.kind === "local";

  return (
    <div className={`doc-activity${visible ? " doc-activity--visible" : ""}`} aria-live="polite">
      {content.phase === "settled" ? (
        <span className="doc-activity-pill doc-activity-pill--done">
          <svg className="doc-activity-check" viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
            <path d="M4 10.5 L8.5 15 L16 5.5" />
          </svg>
          <span className="doc-activity-label">{isLocal ? "Saved" : "Up to date"}</span>
        </span>
      ) : content.phase === "active" ? (
        <span className="doc-activity-pill">
          <span className="doc-activity-spinner" aria-hidden="true" />
          <span className="doc-activity-label">{isLocal ? "Saving" : "Updating"}</span>
          <span className="doc-activity-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </span>
      ) : null}
    </div>
  );
}
