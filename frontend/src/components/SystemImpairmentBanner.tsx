import { Link } from "react-router-dom";
import type { ImpairmentReport } from "../types/shared.js";
import { DocPath } from "../types/shared.js";
import { docHref } from "../app/docs-location";

interface SystemImpairmentBannerProps {
  impairments: ImpairmentReport[];
}

export function SystemImpairmentBanner({ impairments }: SystemImpairmentBannerProps) {
  if (impairments.length === 0) return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-10 flex flex-col">
      {impairments.map((impairment) => (
        <div
          key={impairment.id}
          role="alert"
          data-testid="system-impairment"
          className="shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-900"
        >
          {impairment.message}
          {impairment.doc_paths.length > 0 ? (
            <>
              {" — affected: "}
              {impairment.doc_paths.map((path, i) => (
                <span key={path}>
                  {i > 0 ? ", " : ""}
                  <Link to={docHref(DocPath.parse(path))} className="font-medium underline">
                    {path}
                  </Link>
                </span>
              ))}
            </>
          ) : null}
          {" — "}
          <Link to={`/admin/proposals/${impairment.id}`} className="font-medium underline">
            view proposal
          </Link>
        </div>
      ))}
    </div>
  );
}
