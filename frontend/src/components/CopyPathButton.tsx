import { copyTextToClipboard } from "../utils/copy-text";

export function CopyPathButton({
  path,
  label,
  copied,
  onCopied,
}: {
  path: string;
  label: string;
  copied: boolean;
  onCopied: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint hover:bg-section-hover hover:text-text-muted"
      title={copied ? "Copied" : "Copy path"}
      aria-label={copied ? "Path copied" : `Copy path for ${label}`}
      onClick={async (event) => {
        event.stopPropagation();
        const didCopy = await copyTextToClipboard(path);
        if (!didCopy) return;
        onCopied(path);
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3.5 8.5L6.5 11.5L12.5 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
          <path
            d="M10.5 5.5V4.25C10.5 3.56 9.94 3 9.25 3H4.25C3.56 3 3 3.56 3 4.25V9.25C3 9.94 3.56 10.5 4.25 10.5H5.5"
            stroke="currentColor"
            strokeWidth="1.25"
          />
        </svg>
      )}
    </button>
  );
}
