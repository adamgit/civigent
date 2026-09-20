import { useCallback, useLayoutEffect, useRef, useState } from "react";
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
  return (first && docsRouteForStoredPath(first.path)) || "/agent-pulse";
}

export function AgentChangeTile({ task, visibleFiles = 5 }: AgentChangeTileProps) {
  const tileRef = useRef<HTMLAnchorElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [lensPlacement, setLensPlacement] = useState<"above" | "below">("below");
  const lines: Array<{ kind: "wrote" | "read"; touch: HomeAgentTaskTouch }> = [
    ...task.writes.map((touch) => ({ kind: "wrote" as const, touch })),
    ...task.reads.map((touch) => ({ kind: "read" as const, touch })),
  ];
  const shown = lines.slice(0, visibleFiles);
  const hidden = lines.length - shown.length;
  const at = new Date(task.endedAt ?? task.startedAt);
  const clock = formatHomeClock(at);

  const updateLensPlacement = useCallback(() => {
    const tile = tileRef.current;
    if (!tile) return;

    const tileRect = tile.getBoundingClientRect();
    const scrollViewport = tile.closest<HTMLElement>(".agent-panel__body");
    const viewportRect = scrollViewport?.getBoundingClientRect();
    const visibleTop = Math.max(0, viewportRect?.top ?? 0);
    const visibleBottom = Math.min(window.innerHeight, viewportRect?.bottom ?? window.innerHeight);
    const viewportMiddle = visibleBottom > visibleTop
      ? (visibleTop + visibleBottom) / 2
      : window.innerHeight / 2;
    const tileMiddle = (tileRect.top + tileRect.bottom) / 2;

    setLensPlacement(tileMiddle < viewportMiddle ? "below" : "above");
  }, []);

  useLayoutEffect(() => {
    if (!hovered && !focused) return;

    updateLensPlacement();
    window.addEventListener("scroll", updateLensPlacement, true);
    window.addEventListener("resize", updateLensPlacement);
    return () => {
      window.removeEventListener("scroll", updateLensPlacement, true);
      window.removeEventListener("resize", updateLensPlacement);
    };
  }, [focused, hovered, updateLensPlacement]);

  return (
    <Link
      ref={tileRef}
      className="mosaic-tile"
      to={tileHref(task)}
      data-lens-placement={lensPlacement}
      aria-label={`${clock}, ${task.displayName}: ${task.intent}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
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
