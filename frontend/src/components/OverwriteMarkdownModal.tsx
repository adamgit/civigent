import { useState } from "react";
import { apiClient } from "../services/api-client.js";

interface OverwriteMarkdownModalProps {
  docPath: string;
  onClose: () => void;
}

export function OverwriteMarkdownModal({ docPath, onClose }: OverwriteMarkdownModalProps) {
  const [markdown, setMarkdown] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiClient.overwriteDoc(docPath, markdown);
      setResult(`Document overwritten. Commit: ${res.committed_sha.slice(0, 7)}`);
      setTimeout(() => {
        onClose();
        window.location.reload();
      }, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl max-w-[95vw] max-h-[90vh] w-[700px] overflow-y-auto p-6">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 text-xl leading-none"
        >
          &times;
        </button>

        <h2 className="text-lg font-semibold mb-1">Overwrite from Markdown</h2>
        <p className="text-xs text-gray-500 mb-3">
          This will replace the entire document. The previous version is recoverable from git history.
        </p>

        <textarea
          className="w-full h-[300px] border border-gray-300 rounded p-3 text-sm font-mono resize-y focus:outline-none focus:ring-1 focus:ring-blue-400"
          placeholder="Paste raw markdown here..."
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          disabled={submitting}
        />

        {error && (
          <p className="mt-2 text-sm text-red-600">{error}</p>
        )}
        {result && (
          <p className="mt-2 text-sm text-green-600">{result}</p>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!markdown.trim() || submitting}
            className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Overwriting\u2026" : "Confirm Overwrite"}
          </button>
        </div>
      </div>
    </div>
  );
}
