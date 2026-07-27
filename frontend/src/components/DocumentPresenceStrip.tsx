/**
 * DocumentPresenceStrip (P10) — pure render of the discrete
 * {@link DocumentPresenceModel}. Humans left, agents right; within a side, every
 * badge renders (an actor may appear in both the presence and write lanes, and
 * both show). The strip is absolute-positioned inside the paper header's existing
 * `position: relative` context and has zero layout height, so the title/path do
 * not move when it mounts, updates, or unmounts (see `.presence-strip` in
 * styles.css).
 *
 * No timers, no opacity math here — the `recent` fade is CSS, restarted by keying
 * each badge on its opaque `fadeKey` (a changed key remounts the element, replaying
 * the animation from full opacity).
 */

import type {
  DocumentPresenceModel,
  PresenceBadge as PresenceBadgeModel,
} from "../presence/document-presence-model";

function PresenceBadge({ badge }: { badge: PresenceBadgeModel }): JSX.Element {
  const className = [
    "presence-badge",
    `presence-badge--${badge.kind}`,
    `presence-badge--lane-${badge.lane}`,
    `presence-badge--${badge.engagement}`,
  ].join(" ");
  return (
    <span
      className={className}
      style={{ ["--presence-badge-fill" as string]: badge.fillColor }}
      title={badge.displayName}
      aria-label={badge.displayName}
      data-testid="presence-badge"
      data-kind={badge.kind}
      data-lane={badge.lane}
      data-engagement={badge.engagement}
    >
      {badge.initials}
    </span>
  );
}

/** Stable per-badge React key: identity + lane + fadeKey so a fresh fade remounts. */
function badgeKey(badge: PresenceBadgeModel): string {
  return `${badge.lane}:${badge.id}:${badge.fadeKey}`;
}

export function DocumentPresenceStrip({
  model,
}: {
  model: DocumentPresenceModel;
}): JSX.Element | null {
  if (model.humans.length === 0 && model.agents.length === 0) return null;
  return (
    <div className="presence-strip" data-testid="presence-strip" aria-hidden={false}>
      <div className="presence-strip__side presence-strip__side--humans">
        {model.humans.map((badge) => (
          <PresenceBadge key={badgeKey(badge)} badge={badge} />
        ))}
      </div>
      <div className="presence-strip__side presence-strip__side--agents">
        {model.agents.map((badge) => (
          <PresenceBadge key={badgeKey(badge)} badge={badge} />
        ))}
      </div>
    </div>
  );
}
