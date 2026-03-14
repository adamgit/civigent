import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { DocsBrowserPage } from "../pages/DocsBrowserPage";
import { DocumentPage } from "../pages/DocumentPage";

export type DocsRouteMode = "view";

export interface ResolvedDocsRoute {
  mode: DocsRouteMode;
  docPath: string | null;
}

function normalizeSplatPath(routeSplat: string | undefined): string {
  if (!routeSplat) {
    return "";
  }
  return decodeURIComponent(routeSplat).replace(/^\/+|\/+$/g, "");
}

export function resolveDocsSubroute(routeSplat: string | undefined): ResolvedDocsRoute {
  const normalized = normalizeSplatPath(routeSplat);
  if (normalized.length === 0) {
    return { mode: "view", docPath: null };
  }
  return { mode: "view", docPath: normalized };
}

export function DocsRouteResolver() {
  const params = useParams();
  const resolved = useMemo(() => resolveDocsSubroute(params["*"]), [params]);

  if (!resolved.docPath) {
    return <DocsBrowserPage />;
  }
  return <DocumentPage key={resolved.docPath} docPathOverride={resolved.docPath} />;
}
