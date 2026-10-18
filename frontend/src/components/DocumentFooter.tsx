import { useSyncExternalStore } from "react";
import {
  describeAppWsBroadcastFallback,
  getAppWsTransportInfo,
  subscribeAppWsTransport,
} from "../services/ws-client";
import { footerLinkLabel, footerSessionLabel } from "../status/document-footer-clauses";
import type { LiveDocumentSession } from "../status/live-document-session";

interface DocumentFooterProps {
  docPath: string | null;
  session: LiveDocumentSession;
  headingLabel: string | null;
  proposalMode: boolean;
  transportError: string | null;
  loadDurationMs: number | null;
}

function Separator() {
  return <span className="mx-1.5 text-[#d0ccc4]">&middot;</span>;
}

export function DocumentFooter({
  docPath,
  session,
  headingLabel,
  proposalMode,
  transportError,
  loadDurationMs,
}: DocumentFooterProps) {
  const transport = useSyncExternalStore(subscribeAppWsTransport, getAppWsTransportInfo, getAppWsTransportInfo);
  const showBroadcastFallback = transport.kind === "broadcast-fallback";
  const linkLabel = footerLinkLabel(session);
  const sessionLabel = footerSessionLabel({ session, headingLabel, proposalMode });

  return (
    <div className="h-[--spacing-footer-h] min-h-[--spacing-footer-h] bg-footer-bg border-t border-footer-border flex items-center px-3.5 gap-1 text-[10.5px] text-footer-text font-[family-name:var(--font-mono)]">
      <span>{docPath ?? "No document"}</span>
      <Separator />
      <span>{linkLabel}</span>
      <Separator />
      <span>{sessionLabel}</span>
      {transportError !== null ? (
        <>
          <Separator />
          <span className="text-status-red" title={transportError}>Save failed</span>
        </>
      ) : null}
      {loadDurationMs !== null ? (
        <>
          <Separator />
          <span>Page loaded in {(loadDurationMs / 1000).toFixed(1)}s</span>
        </>
      ) : null}
      {showBroadcastFallback ? (
        <>
          <Separator />
          <span
            className="inline-flex items-center px-1.5 py-px rounded-[3px] bg-[#f4a261] text-[#5c2e0a] text-[10px] font-medium leading-none cursor-help"
            title={describeAppWsBroadcastFallback(transport.fallbackReason)}
          >
            Broadcast Fallback
          </span>
        </>
      ) : null}
    </div>
  );
}
