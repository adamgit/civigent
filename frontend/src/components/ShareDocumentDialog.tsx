import { useState } from "react";
import { apiClient } from "../services/api-client.js";
import type { DocPath, ShareGrantExpiry } from "../types/shared.js";

interface ShareDocumentDialogProps {
  docPath: DocPath;
  onClose: () => void;
}

const EXPIRY_CHOICES: Array<{ value: ShareGrantExpiry; label: string }> = [
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: "never", label: "Never" },
];

export function ShareDocumentDialog({ docPath, onClose }: ShareDocumentDialogProps) {
  const [action, setAction] = useState<"read" | "write">("write");
  const [expiry, setExpiry] = useState<ShareGrantExpiry>(7);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<{ url: string; exp: number; expiry: ShareGrantExpiry } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      setLink({ ...(await apiClient.createShareLink(docPath, action, expiry)), expiry });
      setCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl max-w-[95vw] w-[520px] p-6">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 text-xl leading-none"
        >
          &times;
        </button>

        <h2 className="text-lg font-semibold mb-1">Share this document by link</h2>
        <p className="text-xs text-gray-500 mb-4 break-all">{docPath}</p>

        <div className="mb-4">
          <div className="text-sm font-medium mb-1">Anyone with the link</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setAction("write")}
              className={`px-3 py-1.5 text-sm rounded border ${action === "write" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
            >
              Can edit
            </button>
            <button
              type="button"
              onClick={() => setAction("read")}
              className={`px-3 py-1.5 text-sm rounded border ${action === "read" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
            >
              Can view
            </button>
          </div>
        </div>

        <div className="mb-4">
          <div className="text-sm font-medium mb-1">Link expires in</div>
          <div className="flex gap-2">
            {EXPIRY_CHOICES.map((choice) => (
              <button
                key={String(choice.value)}
                type="button"
                onClick={() => setExpiry(choice.value)}
                className={`px-3 py-1.5 text-sm rounded border ${expiry === choice.value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="mt-2 mb-2 text-sm text-red-600">{error}</p>}

        {link ? (
          <div>
            <div className="flex gap-2 items-center">
              <input
                readOnly
                value={link.url}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1.5 text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => { void handleCopy(); }}
                className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Anyone with this link can {action === "write" ? "edit" : "read"} this document{" "}
              {link.expiry === "never"
                ? "until an administrator revokes it"
                : `until ${new Date(link.exp * 1000).toLocaleString()}`}
              . They will not see other documents.
            </p>
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => { void handleCreate(); }}
              disabled={creating}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {creating ? "Creating…" : "Create link"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
