/**
 * document-presence-activity — pure view-model over {@link DocumentPresenceModel}
 * for the narrative activity line (colored status dots + grouped prose).
 *
 * Status (lane × kind × engagement), not actor identity, chooses the dot color.
 * Actors with the same status collapse into one phrase ("you and Sam viewing").
 * Optional ages from the latest `document:activity` snapshot enrich edit/read
 * wording; inclusion still follows the discrete presence model (local timers).
 */

import type { DocumentActivityEvent } from "../types/shared.js";
import { relativeTime } from "../utils/relativeTime.js";
import type {
  DocumentPresenceModel,
  PresenceBadge,
} from "./document-presence-model";

/** Status buckets rendered as separate narrative chips, in display order. */
export type DocumentPresenceActivityStatus =
  | "human-edited"
  | "human-viewing"
  | "agent-edited"
  | "agent-drafting"
  | "agent-reading";

export interface DocumentPresenceActivityItem {
  readonly status: DocumentPresenceActivityStatus;
  /** CSS color for the status dot. */
  readonly dotColor: string;
  /** Full narrative, e.g. "you and Sam viewing" / "Nina edited 8s ago". */
  readonly narrative: string;
}

const STATUS_DOT_COLOR: Record<DocumentPresenceActivityStatus, string> = {
  "human-edited": "var(--color-agent)",
  "human-viewing": "var(--color-status-green)",
  "agent-edited": "var(--color-agent2)",
  "agent-drafting": "var(--color-agent2)",
  "agent-reading": "var(--color-text-muted)",
};

const STATUS_ORDER: readonly DocumentPresenceActivityStatus[] = [
  "human-edited",
  "human-viewing",
  "agent-edited",
  "agent-drafting",
  "agent-reading",
];

export interface BuildDocumentPresenceActivityOptions {
  currentUserId: string | null;
  /** Latest wire snapshot — used only for optional relative-age text. */
  activity?: DocumentActivityEvent | null;
}

function statusForBadge(badge: PresenceBadge): DocumentPresenceActivityStatus | null {
  if (badge.kind === "human") {
    if (badge.lane === "presence" && badge.engagement === "present") return "human-viewing";
    // Active / recent write pulses. Passive attached (`present` write) stays
    // silent — those humans already appear under viewing via page-open.
    if (badge.lane === "write" && (badge.engagement === "active" || badge.engagement === "recent")) {
      return "human-edited";
    }
    return null;
  }
  // agent
  if (badge.lane === "presence" && badge.engagement === "recent") return "agent-reading";
  if (badge.lane === "write") {
    if (badge.engagement === "present") return "agent-drafting";
    if (badge.engagement === "active" || badge.engagement === "recent") return "agent-edited";
  }
  return null;
}

function joinDisplayNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const head = names.slice(0, -1).join(", ");
  return `${head}, and ${names[names.length - 1]}`;
}

function labelForBadge(badge: PresenceBadge, currentUserId: string | null): string {
  if (currentUserId && badge.id === currentUserId) return "you";
  return badge.displayName;
}

/** Prefer the freshest matching age from the activity snapshot for this actor. */
function ageSecondsFor(
  badge: PresenceBadge,
  status: DocumentPresenceActivityStatus,
  activity: DocumentActivityEvent | null | undefined,
): number | undefined {
  if (!activity) return undefined;
  if (badge.kind === "human") {
    const row = activity.humans.find((h) => h.writer.id === badge.id);
    if (!row) return undefined;
    if (status === "human-edited") {
      return row.last_write_seconds_ago ?? row.last_editor_detach_seconds_ago;
    }
    return undefined;
  }
  const row = activity.agents.find((a) => a.writer.id === badge.id);
  if (!row) return undefined;
  if (status === "agent-edited") return row.last_commit_seconds_ago;
  if (status === "agent-reading") return row.last_read_seconds_ago;
  return undefined;
}

function formatAgeSuffix(secondsAgo: number | undefined): string {
  if (secondsAgo === undefined) return " recently";
  return ` ${relativeTime(Date.now() - secondsAgo * 1000)}`;
}

function narrativeForGroup(
  status: DocumentPresenceActivityStatus,
  badges: PresenceBadge[],
  currentUserId: string | null,
  activity: DocumentActivityEvent | null | undefined,
): string {
  // "you" first when present, then stable model order for the rest.
  const sorted = [...badges].sort((a, b) => {
    const aYou = currentUserId && a.id === currentUserId ? 0 : 1;
    const bYou = currentUserId && b.id === currentUserId ? 0 : 1;
    return aYou - bYou;
  });
  const names = joinDisplayNames(sorted.map((b) => labelForBadge(b, currentUserId)));

  switch (status) {
    case "human-viewing":
      return `${names} viewing`;
    case "human-edited": {
      if (sorted.some((b) => b.engagement === "active")) return `${names} editing`;
      // One age for the group: freshest write among members.
      let best: number | undefined;
      for (const badge of sorted) {
        const age = ageSecondsFor(badge, status, activity);
        if (age !== undefined && (best === undefined || age < best)) best = age;
      }
      return `${names} edited${formatAgeSuffix(best)}`;
    }
    case "agent-drafting":
      return `${names} drafting`;
    case "agent-edited": {
      let best: number | undefined;
      for (const badge of sorted) {
        const age = ageSecondsFor(badge, status, activity);
        if (age !== undefined && (best === undefined || age < best)) best = age;
      }
      return `${names} edited${formatAgeSuffix(best)}`;
    }
    case "agent-reading": {
      let best: number | undefined;
      for (const badge of sorted) {
        const age = ageSecondsFor(badge, status, activity);
        if (age !== undefined && (best === undefined || age < best)) best = age;
      }
      return `${names} read this${formatAgeSuffix(best)}`;
    }
  }
}

/**
 * Collapse a discrete presence snapshot into ordered narrative activity items.
 * Pure: same inputs → same outputs.
 */
export function buildDocumentPresenceActivityItems(
  model: DocumentPresenceModel,
  options: BuildDocumentPresenceActivityOptions,
): DocumentPresenceActivityItem[] {
  const { currentUserId, activity } = options;
  const buckets = new Map<DocumentPresenceActivityStatus, PresenceBadge[]>();

  for (const badge of [...model.humans, ...model.agents]) {
    const status = statusForBadge(badge);
    if (!status) continue;
    const list = buckets.get(status);
    if (list) list.push(badge);
    else buckets.set(status, [badge]);
  }

  const items: DocumentPresenceActivityItem[] = [];
  for (const status of STATUS_ORDER) {
    const badges = buckets.get(status);
    if (!badges || badges.length === 0) continue;
    items.push({
      status,
      dotColor: STATUS_DOT_COLOR[status],
      narrative: narrativeForGroup(status, badges, currentUserId, activity),
    });
  }
  return items;
}
