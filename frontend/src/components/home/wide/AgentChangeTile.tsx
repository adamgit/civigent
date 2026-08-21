import { Link } from "react-router-dom";
import { docsRouteForStoredPath } from "../../../app/docs-location";
import { formatHomeClock } from "../../../pages/home/home-utils";
import type { HomeAgentTask, HomeAgentTaskTouch } from "../experiment/types";

interface AgentChangeTileProps {
  task: HomeAgentTask;
  visibleFiles?: number;
}

function tileHref(task: HomeAgentTask): string {
  const first = task.writes[0] ?? task.reads[0];
  return (first && docsRouteForStoredPath(first.path)) || "/agents-activity";
}

export function AgentChangeTile({ task, visibleFiles = 5 }: AgentChangeTileProps) {
  const lines: Array<{ kind: "wrote" | "read"; touch: HomeAgentTaskTouch }> = [
    ...task.writes.map((touch) => ({ kind: "wrote" as const, touch })),
    ...task.reads.map((touch) => ({ kind: "read" as const, touch })),
  ];
  const shown = lines.slice(0, visibleFiles);
  const hidden = lines.length - shown.length;
  const at = new Date(task.endedAt ?? task.startedAt);
  const clock = formatHomeClock(at);

  return (
    <Link
      className="mosaic-tile"
      to={tileHref(task)}
      aria-label={`${clock}, ${task.displayName}: ${task.intent}`}
    >
      <span className="mosaic-tile__time font-mono" aria-hidden="true">
        {clock}
      </span>

      <span className="mosaic-tile__reason" aria-hidden="true">
        {task.intent}
      </span>

      <span className="mosaic-tile__files" aria-hidden="true">
        {shown.map(({ kind, touch }, index) => (
          <span className="mosaic-tile__file" key={`${touch.path}-${index}`}>
            <i className="mosaic-tile__key" data-kind={kind} />
            <span className="mosaic-tile__doc font-mono" data-kind={kind}>
              {touch.title}
            </span>
          </span>
        ))}
        {hidden > 0 ? (
          <span className="mosaic-tile__file">
            <i className="mosaic-tile__key" data-kind="more" />
            <span className="mosaic-tile__doc font-mono" data-kind="more">
              +{hidden}
            </span>
          </span>
        ) : null}
      </span>

      <span className="mosaic-lens" role="presentation">
        <span className="mosaic-lens__meta font-mono">
          {clock} · {task.displayName}
        </span>
        <span className="mosaic-lens__reason">{task.intent}</span>

        {task.writes.length > 0 ? (
          <FileGroup kind="wrote" label="Wrote" files={task.writes} />
        ) : (
          <span className="mosaic-lens__group-label" data-kind="read">
            Read only — no changes
          </span>
        )}

        {task.reads.length > 0 ? <FileGroup kind="read" label="Read" files={task.reads} /> : null}
      </span>
    </Link>
  );
}

function FileGroup({
  kind,
  label,
  files,
}: {
  kind: "wrote" | "read";
  label: string;
  files: HomeAgentTaskTouch[];
}) {
  return (
    <span className="mosaic-lens__group">
      <span className="mosaic-lens__group-label" data-kind={kind}>
        {label}
      </span>
      {files.map((file) => (
        <span className="mosaic-lens__line" key={file.path}>
          <span className="mosaic-lens__doc font-mono" data-kind={kind}>
            {file.title}
          </span>
          <span className="mosaic-lens__path font-mono">
            {file.sections.length > 0 ? file.sections.join(" › ") : "whole document"}
          </span>
        </span>
      ))}
    </span>
  );
}
