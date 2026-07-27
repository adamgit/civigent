import { useSyncExternalStore } from "react";
import { headingPathToLabel } from "../pages/document-page-utils";
import {
  describeAppWsBroadcastFallback,
  getAppWsTransportInfo,
  subscribeAppWsTransport,
} from "../services/ws-client";

interface DocumentFooterProps {
  docPath: string | null;
  isEditing: boolean;
  focusedHeadingPath: string[] | null;
  loadDurationMs: number | null;
}

export function DocumentFooter({ docPath, isEditing, focusedHeadingPath, loadDurationMs }: DocumentFooterProps) {
  const transport = useSyncExternalStore(subscribeAppWsTransport, getAppWsTransportInfo, getAppWsTransportInfo);
  const showBroadcastFallback = transport.kind === "broadcast-fallback";

  return (
    <div className="h-[--spacing-footer-h] min-h-[--spacing-footer-h] bg-footer-bg border-t border-footer-border flex items-center px-3.5 gap-1 text-[10.5px] text-footer-text font-[family-name:var(--font-mono)]">
      <span>{docPath ?? "No document"}</span>
      <span className="mx-1.5 text-[#d0ccc4]">&middot;</span>
      <span>{isEditing && focusedHeadingPath ? `Editing: ${headingPathToLabel(focusedHeadingPath)}` : "Connected"}</span>
      {loadDurationMs !== null ? (
        <>
          <span className="mx-1.5 text-[#d0ccc4]">&middot;</span>
          <span>Page loaded in {(loadDurationMs / 1000).toFixed(1)}s</span>
        </>
      ) : null}
      {showBroadcastFallback ? (
        <>
          <span className="mx-1.5 text-[#d0ccc4]">&middot;</span>
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
