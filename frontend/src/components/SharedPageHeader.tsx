/**
 * SharedPageHeader — consistent header bar for non-DocumentPage pages.
 *
 * Renders: optional back arrow and page title.
 * Height: 56px. DocumentPage keeps its own unique 46px topbar.
 * Identity lives in the left sidebar (`SidebarIdentity`).
 */

import type React from "react";
import { Link } from "react-router-dom";

interface SharedPageHeaderProps {
  title: React.ReactNode;
  backTo?: string;
}

export function SharedPageHeader({ title, backTo }: SharedPageHeaderProps) {
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
    </div>
  );
}
