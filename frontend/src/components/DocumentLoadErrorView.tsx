import { Link } from "react-router-dom";

interface DocumentLoadErrorViewProps {
  docPath: string | null;
  error: string;
}

/**
 * Load failures for a document page. 404 gets the friendly not-found UX;
 * every other failure must show the backend message verbatim (including stack).
 * See brain spec 17-errors-always-visible / docs/error-handling.md.
 */
export function DocumentLoadErrorView({ docPath, error }: DocumentLoadErrorViewProps) {
  const isNotFound = /^404\b/.test(error);

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--color-page-bg)" }}>
      <div className="px-4 pt-4">
        <Link
          to="/docs"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
        >
          <span className="text-[15px]">&#8592;</span> Back to documents
        </Link>
      </div>
      <div className="flex-1 flex items-center justify-center overflow-auto py-8">
        {isNotFound ? (
          <div className="text-center max-w-md px-6">
            <div className="text-5xl mb-5 opacity-30">&#128196;</div>
            <h2 className="text-lg font-semibold text-text-primary mb-2">
              Document not found
            </h2>
            <p className="text-sm text-text-muted leading-relaxed">
              This document doesn&apos;t exist, may have been deleted, or you don&apos;t have access to it.
            </p>
            <p className="text-xs text-text-muted mt-4 opacity-60 break-all">
              {docPath}
            </p>
          </div>
        ) : (
          <div className="max-w-3xl w-full px-6 space-y-4">
            <h2 className="text-lg font-semibold text-status-red">
              Failed to load document
            </h2>
            {docPath ? (
              <p className="text-xs text-text-muted break-all">{docPath}</p>
            ) : null}
            <pre className="rounded border border-red-200 bg-red-50 p-4 text-xs text-red-800 overflow-auto max-h-[60vh] whitespace-pre-wrap break-words font-mono m-0">
              {error}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
