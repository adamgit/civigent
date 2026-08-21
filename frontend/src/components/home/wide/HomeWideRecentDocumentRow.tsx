import { Link } from "react-router-dom";
import { docHref } from "../../../app/docs-location";
import { DocPath } from "../../../types/shared.js";
import type { HomeDocChangeKind, HomeRecentDocument } from "../../../pages/home/home-recent-documents";
import { formatHomeShortAge } from "../../../pages/home/home-utils";

interface HomeWideRecentDocumentRowProps {
  document: HomeRecentDocument;
  now?: Date;
}

const KIND_LABEL: Record<HomeDocChangeKind, string> = {
  rewritten: "edited",
  added: "added",
  moved: "moved",
};

export function HomeWideRecentDocumentRow({ document: doc, now }: HomeWideRecentDocumentRowProps) {
  const parsed = DocPath.tryParse(doc.docPath);
  const body = (
    <>
      <span className="doc-row__main">
        <span className="doc-row__name font-body">
          {doc.title}
          <span className="doc-row__path">{doc.folderPrefix}</span>
        </span>
        {doc.changes.length > 0 ? (
          <span className="doc-row__edits">
            {doc.changes.map((change) => (
              <span className="doc-row__edit" key={change.kind}>
                <span className="doc-row__edit-kind" data-kind={change.kind}>
                  {KIND_LABEL[change.kind]}
                </span>
                <span className="doc-row__edit-path">{change.headings.join(" › ")}</span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="doc-row__byline">
        <strong>{doc.writerName}</strong> · {formatHomeShortAge(new Date(doc.timestamp), now)}
      </span>
    </>
  );

  if (!parsed) {
    return <div className="doc-row">{body}</div>;
  }
  return (
    <Link className="doc-row" to={docHref(parsed)}>
      {body}
    </Link>
  );
}
