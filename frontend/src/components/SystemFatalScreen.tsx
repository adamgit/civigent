import type { FatalReport } from "../services/system-events-client.js";

interface SystemFatalScreenProps {
  fatal: FatalReport;
}

export function SystemFatalScreen({ fatal }: SystemFatalScreenProps) {
  return (
    <div className="fixed inset-0 z-[99998] flex items-center justify-center bg-slate-950 p-8">
      <div className="max-w-3xl w-full space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-red-400">Backend Fatal Error</h1>
          <p className="text-sm text-slate-400">
            The backend process crashed and is no longer running.
            Restart the dev server to recover.
          </p>
        </div>

        <div className="rounded-lg border border-red-900 bg-red-950/50 p-4 space-y-3">
          <div className="text-red-300 font-medium break-words">{fatal.message}</div>
          <div className="text-xs text-slate-500">
            {fatal.origin} &middot; {fatal.timestamp}
          </div>
        </div>

        {fatal.stack && (
          <pre className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-xs text-slate-300 overflow-auto max-h-[50vh] whitespace-pre-wrap break-words font-mono">
            {fatal.stack}
          </pre>
        )}

        {fatal.cause && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-1">
            <div className="text-xs text-slate-500 font-medium">Cause</div>
            <pre className="text-xs text-slate-300 whitespace-pre-wrap break-words font-mono m-0">
              {fatal.cause}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
