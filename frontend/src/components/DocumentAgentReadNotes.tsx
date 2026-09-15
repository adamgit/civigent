import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { AgentRead } from "../types/shared.js";

export type AgentDocumentRead = Extract<AgentRead, { kind: "document_read" }>;
export type AgentSectionRead = Extract<AgentRead, { kind: "section_read" }>;

interface NoteVariables extends CSSProperties {
  "--agent-read-note-paper": string;
  "--agent-read-note-edge": string;
  "--agent-read-note-ink": string;
  "--agent-read-note-tilt": string;
}

function hashActorId(actorId: string): number {
  let hash = 0;
  for (let index = 0; index < actorId.length; index += 1) {
    hash = actorId.charCodeAt(index) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

function noteVariables(actorId: string, occurrence: number, fullHeight = false): NoteVariables {
  const hash = hashActorId(actorId);
  const hue = hash % 360;
  const tiltUnit = ((hash + occurrence * 17) % 9) - 4;
  const tilt = tiltUnit * (fullHeight ? 0.035 : 0.22);
  return {
    "--agent-read-note-paper": `hsl(${hue} 72% 82%)`,
    "--agent-read-note-edge": `hsl(${hue} 48% 64%)`,
    "--agent-read-note-ink": `hsl(${hue} 42% 22%)`,
    "--agent-read-note-tilt": `${tilt}deg`,
  };
}

function readKey(read: AgentRead): string {
  const heading = read.kind === "section_read" ? read.heading_path.join("\u001f") : "";
  return [
    read.kind,
    read.actor_id,
    read.occurred_at_ms,
    read.source,
    read.doc_path,
    heading,
  ].join(":");
}

function sourceLabel(read: AgentSectionRead): string {
  if (read.source === "history") return "read history";
  if (read.source === "workspace") return "read draft";
  return "read";
}

export function DocumentSectionReadNotes({
  reads,
}: {
  reads: readonly AgentSectionRead[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [availableHeight, setAvailableHeight] = useState(0);
  const hasReads = reads.length > 0;

  useLayoutEffect(() => {
    if (!hasReads) return;
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setAvailableHeight(root.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [hasReads]);

  if (!hasReads) return null;

  const requiredHeight = 40 + Math.max(0, reads.length - 1) * 30;
  const collapsed = reads.length > 1 && availableHeight < requiredHeight;

  if (collapsed) {
    const names = [...new Set(reads.map((read) => read.actor_display_name))];
    const summary = names.join(", ");
    return (
      <div ref={rootRef} className="agent-read-section-notes" aria-live="polite">
        <div
          className="agent-read-section-note agent-read-section-note--collapsed"
          title={`${summary} read this section`}
        >
          <strong>{summary}</strong>
          <span>{reads.length} reads</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="agent-read-section-notes" aria-live="polite">
      {reads.map((read, index) => (
        <div
          key={readKey(read)}
          className="agent-read-section-note"
          style={{
            ...noteVariables(read.actor_id, index),
            top: `${4 + index * 30}px`,
          }}
          title={`${read.actor_display_name} ${sourceLabel(read)} this section`}
        >
          <strong>{read.actor_display_name}</strong>
          <span>{sourceLabel(read)}</span>
        </div>
      ))}
    </div>
  );
}

export function DocumentWholeReadNotes({
  reads,
}: {
  reads: readonly AgentDocumentRead[];
}) {
  if (reads.length === 0) return null;

  return (
    <div className="agent-read-document-notes" aria-live="polite">
      <div className="agent-read-document-gutter">
        {reads.map((read, index) => (
          <div
            key={readKey(read)}
            className="agent-read-document-note"
            style={{
              ...noteVariables(read.actor_id, index, true),
              right: "-8px",
              width: `${44 + (reads.length - index - 1) * 18}px`,
              zIndex: index + 1,
            }}
            aria-label="AI: read document"
          >
            <span>AI: read document</span>
          </div>
        ))}
      </div>
      <div className="agent-read-document-paper-spacer" />
      <div className="agent-read-document-right-spacer" />
    </div>
  );
}
