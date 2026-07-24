/**
 * LinkEditPopup — the React content mounted inside the floating Milkdown
 * link-edit tooltip. A free-text href input (external URLs) plus a document-path
 * autocomplete fed by the workspace tree.
 *
 * Enter confirms the current input text; Escape cancels; clicking a suggestion
 * confirms with that document path. Confirm/cancel are handled by the owning
 * PluginView (option1-edit-view.ts), which applies the link mark.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWorkspaceFilePaths, filterDocPaths } from "./doc-paths";

interface LinkEditPopupProps {
  initialHref: string;
  onConfirm: (href: string) => void;
  onCancel: () => void;
}

export function LinkEditPopup({ initialHref, onConfirm, onCancel }: LinkEditPopupProps) {
  const [value, setValue] = useState(initialHref);
  const [paths, setPaths] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchWorkspaceFilePaths().then((list) => {
      if (!cancelled) setPaths(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus (and pre-select any existing href) on open, matching stock focus behaviour.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const suggestions = useMemo(() => filterDocPaths(paths, value, 8), [paths, value]);

  return (
    <div
      className="link-edit-option1"
      style={{
        minWidth: 260,
        // The tooltip chrome (.milkdown-link-edit) is only position:absolute, so
        // this container must paint its own solid background or the text renders
        // straight over the document and is unreadable.
        background: "var(--crepe-color-surface, #ffffff)",
        color: "var(--crepe-color-on-background, #1f1f1f)",
        border: "1px solid rgba(0, 0, 0, 0.12)",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.18)",
        padding: 8,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          ref={inputRef}
          className="input-area"
          style={{ flex: 1 }}
          value={value}
          placeholder="Paste link or search documents…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm(value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <button
          type="button"
          className="link-edit-option1-confirm"
          title="Confirm link"
          onClick={() => onConfirm(value)}
          style={{ cursor: "pointer" }}
        >
          Confirm ⏎
        </button>
      </div>
      {suggestions.length > 0 ? (
        <ul className="link-edit-option1-suggestions" style={{ listStyle: "none", margin: "6px 0 0", padding: 0, maxHeight: 180, overflowY: "auto" }}>
          {suggestions.map((path) => (
            <li key={path}>
              <button
                type="button"
                // Mouse-down (not click) so the input's blur doesn't race the tooltip teardown.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onConfirm(path);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "4px 6px",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                className="link-edit-option1-suggestion"
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
