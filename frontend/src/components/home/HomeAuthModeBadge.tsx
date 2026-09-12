import { AUTH_MODE_ORDER, AUTH_MODE_UI } from "../../auth-mode-ui";
import type { LoginProvider } from "../../types/shared.js";

interface HomeAuthModeBadgeProps {
  mode: LoginProvider | null;
  className?: string;
}

export function HomeAuthModeBadge({ mode, className }: HomeAuthModeBadgeProps) {
  if (!mode) return null;
  const ui = AUTH_MODE_UI[mode];

  return (
    <span className={`home-auth-mode${className ? ` ${className}` : ""}`}>
      <span className={`home-auth-badge home-auth-badge--${ui.modifier}`}>{ui.label}</span>
      <div className="home-auth-popup" role="tooltip" aria-label="Human login modes">
        <div className="home-auth-popup__kicker">Human login mode</div>
        <ul className="home-auth-popup__list">
          {AUTH_MODE_ORDER.map((entry) => {
            const row = AUTH_MODE_UI[entry];
            const current = entry === mode;
            return (
              <li
                key={entry}
                className={`home-auth-popup__row home-auth-popup__row--${row.modifier}${
                  current ? " home-auth-popup__row--current" : ""
                }`}
              >
                <div className="home-auth-popup__row-head">
                  <span className={`home-auth-badge home-auth-badge--${row.modifier}`}>{row.label}</span>
                  {current ? <span className="home-auth-popup__now">Current</span> : null}
                </div>
                <p className="home-auth-popup__detail">{row.detail}</p>
                <code className="home-auth-popup__env">{row.env}</code>
              </li>
            );
          })}
        </ul>
      </div>
    </span>
  );
}
