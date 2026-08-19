import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { docsRouteForStoredPath } from "../../../app/docs-location.js";
import { formatHomeTime } from "../../../pages/home/home-time.js";
import type { HomeAgentTask, HomeAgentTaskDoc, HomeAgentTaskTouch } from "./types.js";

export function statusLabel(task: HomeAgentTask): string {
  if (task.status === "running") {
    return `running · started ${formatHomeTime(task.startedAt, "long")}`;
  }
  if (task.status === "waiting") {
    return `waiting · started ${formatHomeTime(task.startedAt, "long")}`;
  }
  if (task.status === "exploring") {
    return task.endedAt ? formatHomeTime(task.endedAt, "long") : formatHomeTime(task.startedAt, "long");
  }
  return `finished ${formatHomeTime(task.endedAt ?? task.startedAt, "long")}`;
}

function DocLink({ doc, kind }: { doc: HomeAgentTaskDoc; kind: "in" | "out" }) {
  const href = docsRouteForStoredPath(doc.path);
  const className = `home-experiment-doc home-experiment-doc--${kind}`;
  if (!href) {
    return <span className={className}>{doc.title}</span>;
  }
  return (
    <Link to={href} className={className}>
      {doc.title}
    </Link>
  );
}

function coloredDocs(task: HomeAgentTask): Array<{ doc: HomeAgentTaskDoc; kind: "in" | "out" }> {
  const written = new Set(task.writes.map((doc) => doc.path));
  const chips: Array<{ doc: HomeAgentTaskDoc; kind: "in" | "out" }> = [];
  for (const doc of task.writes) chips.push({ doc, kind: "out" });
  for (const doc of task.reads) {
    if (!written.has(doc.path)) chips.push({ doc, kind: "in" });
  }
  return chips;
}

function FileGroupList({
  files,
  kind,
}: {
  files: HomeAgentTaskTouch[];
  kind: "in" | "out";
}) {
  if (files.length === 0) return null;
  return (
    <ol className="home-pulse-pane__files">
      {files.map((file) => (
        <li key={file.path} className="home-pulse-pane__file">
          <DocLink doc={file} kind={kind} />
          {file.sections.length > 0 ? (
            <ol className="home-pulse-pane__sections">
              {file.sections.map((section) => (
                <li key={section}>{section}</li>
              ))}
            </ol>
          ) : (
            <div className="home-pulse-pane__whole">whole document</div>
          )}
        </li>
      ))}
    </ol>
  );
}

function HomePulseHoverPane({
  task,
  anchor,
  onEnter,
  onLeave,
}: {
  task: HomeAgentTask;
  anchor: HTMLElement;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => {
    const rect = anchor.getBoundingClientRect();
    return { top: rect.bottom + 8, left: rect.left };
  });

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const pane = paneRef.current;
      const width = pane?.offsetWidth ?? 320;
      const height = pane?.offsetHeight ?? 280;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = rect.left;
      if (left + width > vw - 8) left = Math.max(8, vw - width - 8);
      let top = rect.bottom + 8;
      if (top + height > vh - 8) {
        top = Math.max(8, rect.top - height - 8);
      }
      setPos({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, task.id]);

  return createPortal(
    <div
      ref={paneRef}
      className="home-pulse-pane"
      role="tooltip"
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="home-pulse-pane__agent">{task.displayName}</div>
      <div className="home-pulse-pane__status">{statusLabel(task)}</div>
      <p className="home-pulse-pane__intent">{task.intent}</p>
      {task.writes.length > 0 ? (
        <section className="home-pulse-pane__group">
          <h3 className="home-pulse-pane__heading home-pulse-pane__heading--out">Wrote</h3>
          <FileGroupList files={task.writes} kind="out" />
        </section>
      ) : null}
      {task.reads.length > 0 ? (
        <section className="home-pulse-pane__group">
          <h3 className="home-pulse-pane__heading home-pulse-pane__heading--in">Read</h3>
          <FileGroupList files={task.reads} kind="in" />
        </section>
      ) : null}
      {task.reads.length === 0 && task.writes.length === 0 ? (
        <p className="home-pulse-pane__empty">No documents recorded for this stretch.</p>
      ) : null}
    </div>,
    document.body,
  );
}

export function HomePulseTaskCard({ task }: { task: HomeAgentTask }) {
  const itemRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const docs = coloredDocs(task);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  const show = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };
  const hide = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  return (
    <article
      ref={itemRef}
      className="home-pulse-item"
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <div className="home-pulse-item__agent">{task.displayName}</div>
      <div className="home-pulse-item__intent">{task.intent}</div>
      {docs.length > 0 ? (
        <div className="home-pulse-item__docs">
          {docs.map(({ doc, kind }, index) => (
            <span key={`${kind}:${doc.path}`}>
              {index > 0 ? " " : null}
              <DocLink doc={doc} kind={kind} />
            </span>
          ))}
        </div>
      ) : null}
      {open && itemRef.current ? (
        <HomePulseHoverPane task={task} anchor={itemRef.current} onEnter={show} onLeave={hide} />
      ) : null}
    </article>
  );
}

export function HomeAgentStatusRow({ task }: { task: HomeAgentTask }) {
  return (
    <div className="home-agent-status">
      <span className={`home-experiment-task__dot home-experiment-task__dot--${task.status}`} aria-hidden="true" />
      <div className="min-w-0">
        <div className="home-agent-status__name">{task.displayName}</div>
        <div className="home-agent-status__sub">{statusLabel(task)}</div>
      </div>
    </div>
  );
}
