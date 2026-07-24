/**
 * Compact current-user control for the left sidebar.
 * Always visible (every route). Click opens a centered identity modal.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCurrentUser } from "../contexts/CurrentUserContext";
import { apiClient } from "../services/api-client";
import { userInitials } from "./user-identity-utils";

export function SidebarIdentity() {
  const currentUser = useCurrentUser();
  const [modalOpen, setModalOpen] = useState(false);

  if (!currentUser) {
    return (
      <div className="px-3.5 py-2 border-t border-sidebar-border">
        <Link
          to="/login"
          className="block text-xs text-sidebar-heading hover:text-sidebar-text-hover transition-colors"
          style={{ fontFamily: "var(--font-ui)", textDecoration: "none" }}
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="px-3.5 py-2 border-t border-sidebar-border">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="w-full flex items-center gap-2 bg-transparent border-none cursor-pointer p-0 text-left hover:opacity-90 transition-opacity"
          aria-label={`Signed in as ${currentUser.displayName}. Open identity details.`}
        >
          <div
            className="flex items-center justify-center rounded-full bg-accent text-white text-[10px] font-bold shrink-0"
            style={{ width: 26, height: 26 }}
          >
            {userInitials(currentUser.displayName)}
          </div>
          <span
            className="min-w-0 flex-1 text-xs text-sidebar-text truncate"
            style={{ fontFamily: "var(--font-ui)" }}
            title={currentUser.displayName}
          >
            {currentUser.displayName}
          </span>
        </button>
      </div>
      {modalOpen ? (
        <IdentityModal onClose={() => setModalOpen(false)} />
      ) : null}
    </>
  );
}

function IdentityModal({ onClose }: { onClose: () => void }) {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const titleId = useId();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!currentUser) return null;

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await apiClient.logout();
      onClose();
      navigate("/login");
    } catch {
      setLoggingOut(false);
    }
  };

  const typeLabel = currentUser.type === "human" ? "Human" : "Agent";
  const typeTextClass =
    currentUser.type === "human" ? "text-status-green" : "text-agent-text";
  const typeDotClass =
    currentUser.type === "human" ? "bg-status-green" : "bg-agent";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/40 border-none cursor-pointer p-0"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        className="relative bg-white rounded-lg shadow-xl max-w-[95vw] w-[400px] p-6"
        style={{ fontFamily: "var(--font-ui)" }}
      >
        <div className="flex items-center gap-3 mb-4">
          <div
            className="flex items-center justify-center rounded-full bg-accent text-white text-sm font-bold shrink-0"
            style={{ width: 40, height: 40 }}
          >
            {userInitials(currentUser.displayName)}
          </div>
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-lg font-semibold text-text-primary leading-tight truncate"
            >
              {currentUser.displayName}
            </h2>
            <span className={`inline-flex items-center gap-1 text-xs mt-0.5 ${typeTextClass}`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${typeDotClass}`} />
              {typeLabel}
            </span>
          </div>
        </div>

        <dl className="grid gap-2 text-sm mb-5">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-0.5">
              Id
            </dt>
            <dd className="text-text-primary font-mono text-xs break-all">{currentUser.id}</dd>
          </div>
          {currentUser.email ? (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-0.5">
                Email
              </dt>
              <dd className="text-text-primary">{currentUser.email}</dd>
            </div>
          ) : null}
        </dl>

        <div className="flex items-center justify-end gap-2">
          <Link
            to="/login"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-topbar-border text-text-secondary hover:text-text-primary transition-colors"
            style={{ textDecoration: "none" }}
          >
            Switch identity
          </Link>
          <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white border-none cursor-pointer disabled:opacity-60"
          >
            {loggingOut ? "Logging out…" : "Logout"}
          </button>
        </div>
      </div>
    </div>
  );
}
