/**
 * DocumentPresenceActivity — narrative presence line for the paper header.
 *
 * Sibling renderer to {@link DocumentPresenceStrip} (badge circles): same
 * {@link DocumentPresenceModel}, different presentation. Groups actors by
 * status, paints a status-colored dot, and renders prose
 * ("you and Sam viewing", "Nina edited 8s ago").
 */

import type { JSX } from "react";
import type { DocumentActivityEvent } from "../types/shared.js";
import {
  buildDocumentPresenceActivityItems,
  type DocumentPresenceActivityItem,
} from "../presence/document-presence-activity";
import type { DocumentPresenceModel } from "../presence/document-presence-model";

export function DocumentPresenceActivity({
  model,
  currentUserId,
  activity = null,
}: {
  model: DocumentPresenceModel;
  currentUserId: string | null;
  activity?: DocumentActivityEvent | null;
}): JSX.Element | null {
  const items = buildDocumentPresenceActivityItems(model, { currentUserId, activity });

  if (items.length === 0) return null;

  return (
    <div className="doc-presence-activity" data-testid="doc-presence-activity">
      {items.map((item, index) => (
        <ActivityChip key={item.status} item={item} showSeparator={index > 0} />
      ))}
    </div>
  );
}

function ActivityChip({
  item,
  showSeparator,
}: {
  item: DocumentPresenceActivityItem;
  showSeparator: boolean;
}): JSX.Element {
  return (
    <>
      {showSeparator ? <span className="doc-presence-activity__sep" aria-hidden="true">·</span> : null}
      <span
        className="doc-presence-activity__chip"
        data-status={item.status}
      >
        <span
          className="doc-presence-activity__dot"
          style={{ background: item.dotColor }}
          aria-hidden="true"
        />
        <span className="doc-presence-activity__text">{item.narrative}</span>
      </span>
    </>
  );
}
