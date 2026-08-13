import { useEffect, useRef } from "react";
import type { SectionEditRejectedEvent } from "../types/shared";

interface SectionEditRejectedModalProps {
  event: SectionEditRejectedEvent;
  onDismiss: () => void;
}

/**
 * Interruptive dedicated UI for a CRDT live-edit that the server rejected for
 * this tab. Distinct from the topbar save status, the connection banner, the
 * inline info display, and generic error banners — those channels handle
 * transport/save conditions, not semantic per-section rejection.
 *
 * Copy is server-authored (each field is rendered verbatim). Dismissal is
 * user-initiated only; the shared Y.Doc correction has already restored
 * accepted content, so editors remain usable after dismiss.
 */
export function SectionEditRejectedModal({ event, onDismiss }: SectionEditRejectedModalProps) {
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    previouslyFocusedElementRef.current = active instanceof HTMLElement ? active : null;
    return () => {
      const el = previouslyFocusedElementRef.current;
      if (el && el.isConnected) el.focus();
    };
  }, []);

  const affected = event.affected_fragments ?? [];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="section-edit-rejected-title"
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-lg shadow-xl max-w-[95vw] max-h-[90vh] w-[560px] overflow-y-auto p-6">
        <h2
          id="section-edit-rejected-title"
          className="text-lg font-semibold text-red-700 mb-2"
        >
          {event.title}
        </h2>
        <p className="text-sm text-gray-800 mb-3">{event.message}</p>

        {affected.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
              Affected section{affected.length === 1 ? "" : "s"}
            </div>
            <ul className="text-sm text-gray-800 list-disc list-inside">
              {affected.map((f) => (
                <li key={f.fragment_key}>
                  {f.heading_path && f.heading_path.length > 0
                    ? f.heading_path.join(" > ")
                    : f.heading ?? f.fragment_key}
                </li>
              ))}
            </ul>
          </div>
        )}

        <dl className="grid grid-cols-1 gap-2 text-sm mb-4">
          <div>
            <dt className="font-semibold text-gray-700">What happened</dt>
            <dd className="text-gray-800">{event.what_happened}</dd>
          </div>
          <div>
            <dt className="font-semibold text-gray-700">Why it was rejected</dt>
            <dd className="text-gray-800">{event.why_rejected}</dd>
          </div>
          <div>
            <dt className="font-semibold text-gray-700">What the server did</dt>
            <dd className="text-gray-800">{event.server_action}</dd>
          </div>
          <div>
            <dt className="font-semibold text-gray-700">What to try instead</dt>
            <dd className="text-gray-800">{event.guidance}</dd>
          </div>
        </dl>

        <div className="flex justify-end">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
