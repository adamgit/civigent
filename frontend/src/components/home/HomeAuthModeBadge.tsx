import { useEffect, useId, useRef, useState } from "react";
import { AUTH_MODE_ORDER, AUTH_MODE_UI } from "../../auth-mode-ui";
import type { LoginProvider } from "../../types/shared.js";

interface HomeAuthModeBadgeProps {
  mode: LoginProvider | null;
  className?: string;
}

export function HomeAuthModeBadge({ mode, className }: HomeAuthModeBadgeProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popupId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!mode) return null;
  const ui = AUTH_MODE_UI[mode];

  return (
    <span ref={rootRef} className="home-auth-mode">
      <button
        type="button"
        className={`home-auth-badge home-auth-badge--${ui.modifier}${className ? ` ${className}` : ""}`}
        aria-expanded={open}
        aria-controls={popupId}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        {ui.label}
      </button>
      {open ? (
        <div id={popupId} className="home-auth-popup" role="dialog" aria-label="Human login modes">
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
      ) : null}
    </span>
  );
}
