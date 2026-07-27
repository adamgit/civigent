/**
 * useDocumentPresenceModel — subscribes the presence reducer (via the effectful
 * {@link DocumentPresenceAdapter}) to the server's complete `document:activity`
 * snapshot and returns the discrete {@link DocumentPresenceModel} for the
 * presence strip to render.
 *
 * The snapshot is the AUTHORITATIVE shared view: the backend projects open CRDT
 * sockets (page-open), attached editors, accepted-write/final-detach recency,
 * agent reads, agent draft ownership, and recent agent commits into one complete
 * replacement event per document. This hook maps each snapshot onto the
 * floor-plus-pulse model:
 *  - page-open humans → presence-lane `present` floor (the authenticated local
 *    user is ALWAYS seeded, keyed by `currentUser.id`, so the strip is never
 *    empty before the first snapshot arrives);
 *  - attached editors → write-lane `present` floor; a fresh accepted write
 *    (`last_write_seconds_ago` within the active window, editor still attached)
 *    raises it to a timed `active` hold;
 *  - a final editor detach age → write-lane `recent` fade for its remaining window;
 *  - agent drafts → write-lane floor; agent read/commit ages → timed presence-
 *    lane / write-lane `recent` fades (duplicate badges per agent preserved).
 *
 * Every wire age (`seconds_ago`) is converted to a REMAINING local duration
 * against the adapter's clock — no server timestamp is compared to a local one.
 * The adapter emits a new snapshot only when the serialized discrete model
 * changes, so repeated identical snapshots never re-render React.
 */

import { useEffect, useRef, useState } from "react";
import type { AuthUser, DocumentActivityEvent } from "../types/shared.js";
import {
  DocumentPresenceAdapter,
  type PresenceEnvironment,
} from "./document-presence-adapter";
import type { BadgeIdentity } from "./document-presence-core";
import {
  EMPTY_DOCUMENT_PRESENCE_MODEL,
  type DocumentPresenceModel,
  type PresenceKind,
  type PresenceLane,
} from "./document-presence-model";
import { HUMAN_ACTIVE_WRITE_WINDOW_MS } from "./document-presence-constants";
import { deriveFillColor, deriveInitials } from "./document-presence-identity";

export interface DocumentPresenceInputs {
  /** Latest complete `document:activity` snapshot for this doc, or null before the first one. */
  activity: DocumentActivityEvent | null;
  /** The authenticated local user — always shown, keyed by `currentUser.id`. */
  currentUser: AuthUser | null;
  /** Test-only clock/timer/wake injection; defaults to real timers + DOM events. */
  env?: PresenceEnvironment;
}

function badgeIdentity(
  id: string,
  displayName: string,
  kind: PresenceKind,
  lane: PresenceLane,
): BadgeIdentity {
  return {
    id,
    displayName,
    initials: deriveInitials(displayName),
    fillColor: deriveFillColor(id),
    kind,
    lane,
  };
}

export function useDocumentPresenceModel(
  inputs: DocumentPresenceInputs,
): DocumentPresenceModel {
  const { activity, currentUser, env } = inputs;

  // One adapter per hook mount. `env` is only read at construction time.
  const adapterRef = useRef<DocumentPresenceAdapter | null>(null);
  if (adapterRef.current === null) {
    adapterRef.current = new DocumentPresenceAdapter(env);
  }
  const adapter = adapterRef.current;

  const [model, setModel] = useState<DocumentPresenceModel>(
    () => adapter.snapshot() ?? EMPTY_DOCUMENT_PRESENCE_MODEL,
  );

  // Subscribe once; tear the adapter (timers + tab listeners) down on unmount.
  useEffect(() => {
    const unsubscribe = adapter.subscribe(setModel);
    setModel(adapter.snapshot());
    return () => {
      unsubscribe();
      adapter.dispose();
    };
  }, [adapter]);

  useEffect(() => {
    const nowMs = adapter.nowMs();
    const presenceFloor: BadgeIdentity[] = [];
    const editorFloors: BadgeIdentity[] = [];
    const agentDraftFloors: BadgeIdentity[] = [];
    const seenHumanIds = new Set<string>();

    if (currentUser && currentUser.type === "human") {
      seenHumanIds.add(currentUser.id);
      presenceFloor.push(
        badgeIdentity(currentUser.id, currentUser.displayName, "human", "presence"),
      );
    }

    if (activity) {
      for (const row of activity.humans) {
        const writer = row.writer;
        if (row.page_open && !seenHumanIds.has(writer.id)) {
          seenHumanIds.add(writer.id);
          presenceFloor.push(badgeIdentity(writer.id, writer.displayName, "human", "presence"));
        }
        const writeIdentity = badgeIdentity(writer.id, writer.displayName, "human", "write");
        if (row.editor_attached) {
          editorFloors.push(writeIdentity);
          if (row.last_write_seconds_ago !== undefined) {
            adapter.activeFor(
              writeIdentity,
              HUMAN_ACTIVE_WRITE_WINDOW_MS - row.last_write_seconds_ago * 1000,
            );
          }
        } else if (row.last_editor_detach_seconds_ago !== undefined) {
          adapter.recordWriteEvidence(
            writeIdentity,
            nowMs - row.last_editor_detach_seconds_ago * 1000,
          );
        }
      }
      for (const row of activity.agents) {
        const writer = row.writer;
        if (row.has_draft) {
          agentDraftFloors.push(badgeIdentity(writer.id, writer.displayName, "agent", "write"));
        }
        if (row.last_read_seconds_ago !== undefined) {
          adapter.recordAgentRead(
            badgeIdentity(writer.id, writer.displayName, "agent", "presence"),
            nowMs - row.last_read_seconds_ago * 1000,
          );
        }
        if (row.last_commit_seconds_ago !== undefined) {
          adapter.recordWriteEvidence(
            badgeIdentity(writer.id, writer.displayName, "agent", "write"),
            nowMs - row.last_commit_seconds_ago * 1000,
          );
        }
      }
    }

    adapter.syncHumanPresence(presenceFloor, []);
    adapter.syncLaneFloors("write", "human", editorFloors);
    adapter.syncLaneFloors("write", "agent", agentDraftFloors);
  }, [adapter, activity, currentUser]);

  return model;
}
