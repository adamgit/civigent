import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { docsRouteForStoredPath } from "../../../app/docs-location";
import { formatHomeFolderParentPath } from "../../../pages/home/home-utils";
import { formatHomeTime } from "../../../pages/home/home-time";
import type {
  HomeActiveFolder,
  HomeFolderChangedDocument,
  HomeFolderDocChangeKind,
} from "../../../pages/home/home-folder-activity";

interface HomeWideFolderHoverPaneProps {
  folder: HomeActiveFolder;
  anchor: HTMLElement;
  onEnter: () => void;
  onLeave: () => void;
}

const GROUPS: Array<{ kind: HomeFolderDocChangeKind; label: string }> = [
  { kind: "added", label: "Added" },
  { kind: "modified", label: "Modified" },
  { kind: "deleted", label: "Deleted" },
];

function fileNameWithMd(title: string): string {
  return title.endsWith(".md") ? title : `${title}.md`;
}

function DocTitle({ doc, kind }: { doc: HomeFolderChangedDocument; kind: HomeFolderDocChangeKind }) {
  const href = kind === "deleted" ? null : docsRouteForStoredPath(doc.path);
  const className = `home-pulse-pane__doc${kind === "deleted" ? " home-pulse-pane__doc--deleted" : ""}`;
  const name = fileNameWithMd(doc.title);
  if (!href) {
    return <span className={className}>{name}</span>;
  }
  return (
    <Link to={href} className={className} onClick={(event) => event.stopPropagation()}>
      {name}
    </Link>
  );
}

function fileNote(doc: HomeFolderChangedDocument, kind: HomeFolderDocChangeKind): string {
  if (kind === "deleted") return "removed";
  if (doc.sections.length > 0) return "";
  if (kind === "added") return "new document";
  return "whole document";
}

function FileGroupList({
  files,
  kind,
}: {
  files: HomeFolderChangedDocument[];
  kind: HomeFolderDocChangeKind;
}) {
  if (files.length === 0) return null;
  return (
    <ol className="home-pulse-pane__files">
      {files.map((file) => {
        const note = fileNote(file, kind);
        const writers = file.writers.length > 0 ? file.writers.join(", ") : file.lastWriterName;
        const when = file.lastChangedAt ? formatHomeTime(file.lastChangedAt, "long") : "";
        return (
          <li key={file.path} className="home-pulse-pane__file">
            <DocTitle doc={file} kind={kind} />
            {kind === "modified" && file.sections.length > 0 ? (
              <ol className="home-pulse-pane__sections">
                {file.sections.map((section) => (
                  <li key={section}>{section}</li>
                ))}
              </ol>
            ) : note ? (
              <div className="home-pulse-pane__whole">{note}</div>
            ) : null}
            {writers || when ? (
              <div className="home-pulse-pane__file-meta">
                {[writers, when].filter(Boolean).join(" · ")}
              </div>
            ) : null}
            {file.lastIntent ? (
              <div className="home-pulse-pane__file-intent">{file.lastIntent}</div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function HomeWideFolderHoverPane({
  folder,
  anchor,
  onEnter,
  onLeave,
}: HomeWideFolderHoverPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => {
    const rowRect = anchor.getBoundingClientRect();
    const panel = anchor.closest("[data-home-active-folders]");
    const panelRect = panel?.getBoundingClientRect() ?? rowRect;
    return { top: rowRect.top, left: Math.max(8, panelRect.left - 528 - 8) };
  });

  useLayoutEffect(() => {
    const place = () => {
      const rowRect = anchor.getBoundingClientRect();
      const panel = anchor.closest("[data-home-active-folders]");
      const panelRect = panel?.getBoundingClientRect() ?? rowRect;
      const pane = paneRef.current;
      const width = pane?.offsetWidth ?? 528;
      const height = pane?.offsetHeight ?? 280;
      const vh = window.innerHeight;
      let left = panelRect.left - width - 8;
      if (left < 8) left = 8;
      let top = rowRect.top;
      if (top + height > vh - 8) top = Math.max(8, vh - height - 8);
      if (top < 8) top = 8;
      setPos({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, folder.folderPath, folder.writerKind]);

  const parentPath = formatHomeFolderParentPath(folder.folderPath);
  const who = folder.writerKind === "agent" ? "AI agent" : "Human user";
  const counts = [
    folder.counts.added > 0 ? `${folder.counts.added} added` : null,
    folder.counts.modified > 0 ? `${folder.counts.modified} modified` : null,
    folder.counts.deleted > 0 ? `${folder.counts.deleted} deleted` : null,
  ].filter(Boolean);

  return createPortal(
    <div
      ref={paneRef}
      className="home-pulse-pane home-pulse-pane--folder"
      role="tooltip"
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="home-pulse-pane__folder-path">{parentPath ?? "/"}</div>
      <p className="home-pulse-pane__folder-name">{folder.name}</p>
      <div className="home-pulse-pane__status">
        {[
          who,
          formatHomeTime(folder.lastChangedAt, "long"),
          folder.docCount > 0
            ? `${folder.docCount} doc${folder.docCount === 1 ? "" : "s"} in folder`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {counts.length > 0 ? (
        <div className="home-pulse-pane__status">{counts.join(" · ")}</div>
      ) : null}
      {GROUPS.map(({ kind, label }) => {
        const files = folder.changedDocuments.filter((doc) => doc.kinds.includes(kind));
        if (files.length === 0) return null;
        return (
          <section key={kind} className="home-pulse-pane__group">
            <h3 className={`home-pulse-pane__heading home-pulse-pane__heading--${kind === "added" ? "add" : kind === "modified" ? "mod" : "del"}`}>
              {label}
            </h3>
            <FileGroupList files={files} kind={kind} />
          </section>
        );
      })}
      {folder.changedDocuments.length === 0 ? (
        <p className="home-pulse-pane__empty">No documents recorded for this folder.</p>
      ) : null}
    </div>,
    document.body,
  );
}
