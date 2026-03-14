/**
 * SharedPageHeader — consistent header bar for non-DocumentPage pages.
 *
 * Renders: optional back arrow, page title, user identity area (avatar, name, role, switch identity link).
 * Height: 56px. DocumentPage keeps its own unique 46px topbar.
 */

import { Link, useOutletContext } from "react-router-dom";
import type { AppLayoutOutletContext } from "../app/AppLayout";

interface SharedPageHeaderProps {
  title: string;
  backTo?: string;
}

function userInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return displayName.slice(0, 2).toUpperCase();
}

export function SharedPageHeader({ title, backTo }: SharedPageHeaderProps) {
  const { currentUser } = useOutletContext<AppLayoutOutletContext>();

  return (
    <div
      className="flex items-center px-4 gap-3 bg-topbar-bg border-b border-topbar-border shrink-0"
      style={{ height: 56 }}
    >
      {backTo ? (
        <Link
          to={backTo}
          className="text-text-muted hover:text-text-primary transition-colors text-lg leading-none"
          aria-label="Go back"
        >
          &larr;
        </Link>
      ) : null}

      <h1 className="text-xl font-bold text-text-primary" style={{ fontFamily: "var(--font-ui)" }}>
        {title}
      </h1>

      {currentUser ? (
        <div className="ml-auto flex items-center gap-2.5">
          {/* Avatar */}
          <div
            className="flex items-center justify-center rounded-full bg-accent text-white text-xs font-bold"
            style={{ width: 32, height: 32 }}
          >
            {userInitials(currentUser.displayName)}
          </div>

          {/* Name + role + switch */}
          <div className="flex flex-col">
            <span className="text-sm text-text-primary leading-tight" style={{ fontFamily: "var(--font-ui)" }}>
              {currentUser.displayName}
            </span>
            <div className="flex items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1 text-xs leading-tight ${
                  currentUser.type === "human"
                    ? "text-status-green"
                    : "text-agent-text"
                }`}
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full ${
                    currentUser.type === "human"
                      ? "bg-status-green"
                      : "bg-agent"
                  }`}
                />
                {currentUser.type === "human" ? "Human" : "Agent"}
              </span>
              <Link
                to="/login"
                className="text-text-muted text-xs hover:text-text-secondary transition-colors"
              >
                Switch
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
