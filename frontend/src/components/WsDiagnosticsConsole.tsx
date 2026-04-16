import { useEffect, useRef, useState, useCallback } from "react";
import {
  listWsDiagEntries,
  subscribeWsDiag,
  clearWsDiag,
  serializeWsDiag,
  type WsDiagEntry,
} from "../services/ws-diagnostics";

interface WsDiagnosticsConsoleProps {
  open: boolean;
  onClose: () => void;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const mmm = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

export function WsDiagnosticsConsole({ open, onClose }: WsDiagnosticsConsoleProps) {
  const [entries, setEntries] = useState<WsDiagEntry[]>(() => listWsDiagEntries());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeWsDiag(() => {
      setEntries(listWsDiagEntries());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !autoScroll) return;
    const node = logRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [entries, open, autoScroll]);

  const onScroll = useCallback(() => {
    const node = logRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setAutoScroll(distanceFromBottom < 32);
  }, []);

  const onCopyAll = useCallback(async () => {
    const text = serializeWsDiag();
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("copied");
      } else {
        throw new Error("no clipboard");
      }
    } catch {
      setCopyFeedback("copy failed");
    }
    window.setTimeout(() => setCopyFeedback(null), 1500);
  }, []);

  const onClear = useCallback(() => {
    clearWsDiag();
    setExpandedId(null);
  }, []);

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-label="WS Diagnostics Console"
      data-testid="ws-diagnostics-console"
      className="fixed top-0 left-0 right-0 z-50 h-[50vh] bg-black text-green-200 font-mono text-[12px] flex flex-col border-b border-gray-700 shadow-2xl"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700 bg-gray-900">
        <span className="text-gray-400">WS DIAGNOSTICS</span>
        <span className="text-gray-600">· {entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCopyAll}
          className="px-2 py-0.5 bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700 rounded-sm"
        >
          {copyFeedback ?? "Copy all as JSON"}
        </button>
        <button
          type="button"
          onClick={onClear}
          className="px-2 py-0.5 bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700 rounded-sm"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close WS Diagnostics Console"
          className="px-2 py-0.5 bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700 rounded-sm"
        >
          Close
        </button>
      </div>
      <div
        ref={logRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-1.5 leading-[1.35]"
      >
        {entries.length === 0 ? (
          <div className="text-gray-500">(no events captured yet)</div>
        ) : (
          entries.map((entry) => {
            const isExpanded = expandedId === entry.id;
            return (
              <div key={entry.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="w-full text-left block px-0 py-0 bg-transparent border-none cursor-pointer text-green-200 hover:bg-gray-900 focus:bg-gray-900 whitespace-pre-wrap break-words"
                >
                  <span className="text-gray-500">{formatTimestamp(entry.timestamp)}</span>
                  {"  "}
                  <span className="text-cyan-300">{entry.source}</span>
                  {"  "}
                  <span className="text-yellow-200">{entry.type}</span>
                  {"  "}
                  <span>{entry.summary}</span>
                </button>
                {isExpanded ? (
                  <pre className="px-2 py-1 my-1 text-gray-300 bg-gray-900 border border-gray-800 rounded-sm whitespace-pre-wrap break-words">
                    {JSON.stringify(entry, null, 2)}
                  </pre>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
