import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ContentPanel } from "../components/ContentPanel";
import { apiClient } from "../services/api-client";
import { docsRouteForStoredPath } from "../app/docs-location";

function grantTokenFromPathname(pathname: string): string {
  const marker = "/share/";
  const index = pathname.indexOf(marker);
  if (index === -1) return "";
  const raw = pathname.slice(index + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function SharePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const token = grantTokenFromPathname(location.pathname);
  const [name, setName] = useState("Guest");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { doc_path } = await apiClient.redeemShareGrant(token, name.trim() || "Guest");
      const route = docsRouteForStoredPath(doc_path);
      if (!route) {
        setError(`This share link points at an unreadable document path: ${doc_path}`);
        return;
      }
      navigate(route, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-xl mx-auto">
      <ContentPanel>
        <h1 className="text-lg font-semibold mb-1">A document has been shared with you</h1>
        <p className="text-sm text-gray-600 mb-4">
          Choose the name your edits and presence will carry.
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleOpen(); }}
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
          placeholder="Guest"
          disabled={submitting}
        />
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={() => { void handleOpen(); }}
            disabled={submitting || token.length === 0}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Opening…" : "Open document"}
          </button>
        </div>
      </ContentPanel>
    </div>
  );
}
