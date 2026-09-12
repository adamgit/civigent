import { INVOLVEMENT_PRESET_ORDER, INVOLVEMENT_PRESET_UI } from "../../involvement-preset-ui";
import type { HumanInvolvementPresetName } from "../../types/shared.js";

interface HomeInvolvementBadgeProps {
  preset: HumanInvolvementPresetName;
}

export function HomeInvolvementBadge({ preset }: HomeInvolvementBadgeProps) {
  const ui = INVOLVEMENT_PRESET_UI[preset];

  return (
    <span className="home-auth-mode">
      <span className={`home-auth-badge home-auth-badge--${preset}`}>{ui.label}</span>
      <div className="home-auth-popup" role="tooltip" aria-label="AI scoring modes">
        <div className="home-auth-popup__kicker">AI scoring</div>
        <ul className="home-auth-popup__list">
          {INVOLVEMENT_PRESET_ORDER.map((entry) => {
            const row = INVOLVEMENT_PRESET_UI[entry];
            const current = entry === preset;
            return (
              <li
                key={entry}
                className={`home-auth-popup__row home-auth-popup__row--${entry}${
                  current ? " home-auth-popup__row--current" : ""
                }`}
              >
                <div className="home-auth-popup__row-head">
                  <span className={`home-auth-badge home-auth-badge--${entry}`}>{row.label}</span>
                  {current ? <span className="home-auth-popup__now">Current</span> : null}
                </div>
                <p className="home-auth-popup__detail">{row.shortDescription}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </span>
  );
}
