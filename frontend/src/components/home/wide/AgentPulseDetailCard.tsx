import { Link } from "react-router-dom";
import { docsRouteForStoredPath } from "../../../app/docs-location";
import { formatHomeClock } from "../../../pages/home/home-utils";
import type { HomeAgentTask, HomeAgentTaskTouch } from "../experiment/types";

interface AgentPulseDetailCardProps {
  task: HomeAgentTask;
}

function cardHref(task: HomeAgentTask): string {
  const first = task.writes[0] ?? task.reads[0];
  return (first && docsRouteForStoredPath(first.path)) || "/agent-pulse";
}

export function AgentPulseDetailCard({ task }: AgentPulseDetailCardProps) {
  const at = new Date(task.endedAt ?? task.startedAt);
  const clock = formatHomeClock(at);

  return (
    <Link
      className="pulse-detail-card"
      to={cardHref(task)}
      aria-label={`${clock}, ${task.displayName}: ${task.intent}`}
    >
      <span className="pulse-detail-card__meta font-mono">
        {clock} · {task.displayName}
      </span>
      <span className="pulse-detail-card__reason">{task.intent}</span>

      {task.writes.length > 0 ? (
        <FileGroup kind="wrote" label="Wrote" files={task.writes} />
      ) : (
        <span className="pulse-detail-card__group-label" data-kind="read">
          Read only — no changes
        </span>
      )}

      {task.reads.length > 0 ? <FileGroup kind="read" label="Read" files={task.reads} /> : null}
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
    <span className="pulse-detail-card__group">
      <span className="pulse-detail-card__group-label" data-kind={kind}>
        {label}
      </span>
      {files.map((file) => (
        <span className="pulse-detail-card__line" key={file.path}>
          <span className="pulse-detail-card__doc font-mono" data-kind={kind}>
            {file.title}
          </span>
          <span className="pulse-detail-card__path font-mono">
            {file.sections.length > 0 ? file.sections.join(" › ") : "whole document"}
          </span>
        </span>
      ))}
    </span>
  );
}
