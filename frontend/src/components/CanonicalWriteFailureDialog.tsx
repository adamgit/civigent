/**
 * CanonicalWriteFailureDialog — blocking report for a canonical write that failed
 * after the server had already begun mutating content on disk.
 *
 * A failed document delete is indistinguishable from a successful one at a glance:
 * the server deletes the files first and commits them second, so when the commit
 * fails the document is already gone from the tree while the request returns an
 * error. Reporting that as a small red line lets a destroyed-but-uncommitted
 * canonical store pass unnoticed — which is exactly how it went unnoticed for a
 * week. This dialog covers the page, cannot be dismissed by clicking away, and
 * carries the server's full error text (stack included) verbatim.
 */

import { useEffect, useRef } from "react";

export interface CanonicalWriteFailureDialogProps {
  /** What the user asked for, e.g. "Delete document". Names the failed operation. */
  operation: string;
  /** Full server error text, including any stack trace. Never truncated. */
  error: string;
  onDismiss: () => void;
}

export function CanonicalWriteFailureDialog({
  operation,
  error,
  onDismiss,
}: CanonicalWriteFailureDialogProps): JSX.Element {
  const dismissRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    dismissRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      data-testid="canonical-write-failure"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="canonical-write-failure-title"
        className="w-full max-w-2xl max-h-full overflow-auto rounded-lg border-2 border-red-600 bg-white shadow-xl"
      >
        <div className="border-b-2 border-red-600 bg-red-50 px-5 py-4">
          <h2 id="canonical-write-failure-title" className="text-lg font-bold text-red-800">
            {operation} failed — content may be in an inconsistent state
          </h2>
        </div>

        <div className="px-5 py-4 space-y-3 text-sm text-text-primary">
          <p>
            The server changes content files on disk first and records them in git second. This
            operation failed, so the change may already be on disk with nothing recording it — the
            document can look deleted or changed even though the write did not complete.
          </p>
          <p className="font-semibold text-red-800">
            Do not restart the server until this is resolved. Startup refuses to run against an
            unrecorded change, so a restart now can leave the whole system unable to start.
          </p>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
              Full error from the server
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border-default bg-canvas-bg p-3 text-xs text-text-primary">
              {error}
            </pre>
          </div>
        </div>

        <div className="flex justify-end border-t border-border-default px-5 py-3">
          <button
            ref={dismissRef}
            type="button"
            className="rounded border border-red-600 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50"
            onClick={onDismiss}
          >
            I have read this
          </button>
        </div>
      </div>
    </div>
  );
}
