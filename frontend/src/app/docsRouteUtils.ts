export type DocsRouteMode = "view";

export interface ResolvedDocsRoute {
  mode: DocsRouteMode;
  docPath: string | null;
}

function normalizeSplatPath(routeSplat: string | undefined): string {
  if (!routeSplat) {
    return "";
  }
  // Decode, strip trailing slashes only, then ensure exactly one leading slash.
  const decoded = decodeURIComponent(routeSplat).replace(/\/+$/g, "");
  if (!decoded) return "";
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

export function resolveDocsSubroute(routeSplat: string | undefined): ResolvedDocsRoute {
  const normalized = normalizeSplatPath(routeSplat);
  if (normalized.length === 0) {
    return { mode: "view", docPath: null };
  }
  return { mode: "view", docPath: normalized };
}

/**
 * Strip the leading slash from a canonical doc path for embedding in a
 * `/docs/...` browser route URL. The route prefix already provides the
 * leading segment, so the doc path portion must not start with `/`.
 *
 * This is ONLY for route URL construction — do not use it as a general
 * doc-path normalizer.
 */
export function stripLeadingSlashForRoute(docPath: string): string {
  return docPath.replace(/^\/+/, "");
}
