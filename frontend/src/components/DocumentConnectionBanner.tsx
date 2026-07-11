import type { CrdtBannerInfo } from "../services/crdt-connection-ux";

interface DocumentConnectionBannerProps {
  banner: CrdtBannerInfo | null;
}

export function DocumentConnectionBanner({ banner }: DocumentConnectionBannerProps) {
  if (!banner) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-full z-40"
      role="status"
      aria-live="polite"
    >
      <div
        className={`border-b px-4 py-1.5 text-xs font-medium shadow-sm ${
          banner.tone === "red"
            ? "bg-red-50 border-red-200 text-red-800"
            : "bg-amber-50 border-amber-200 text-amber-800"
        }`}
      >
        {banner.message}
      </div>
    </div>
  );
}
