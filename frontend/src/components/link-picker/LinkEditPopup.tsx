/**
 * LinkEditPopup — the React content mounted inside the floating Milkdown
 * link-edit tooltip. A free-text href input (external URLs) plus a document-path
 * autocomplete fed by the workspace tree.
 *
 * ArrowUp/Down highlight a suggestion without moving focus off the input.
 * Enter confirms the highlighted path, or the typed text when nothing is
 * highlighted. Escape cancels. Clicking a suggestion confirms that path.
 * Confirm/cancel are handled by the owning PluginView (option1-edit-view.ts).
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchWorkspaceFilePaths, filterDocPaths } from "./doc-paths";

const SUGGESTION_LIMIT = 20;
const VISIBLE_SUGGESTIONS = 10;
const SUGGESTION_ROW_PX = 28;

interface LinkEditPopupProps {
  initialHref: string;
  onConfirm: (href: string) => void;
  onCancel: () => void;
}

export function LinkEditPopup({ initialHref, onConfirm, onCancel }: LinkEditPopupProps) {
  const [value, setValue] = useState(initialHref);
  const [paths, setPaths] = useState<string[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();

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

  const suggestions = useMemo(
    () => filterDocPaths(paths, value, SUGGESTION_LIMIT),
    [paths, value],
  );

  const confirm = () => {
    const picked = highlightedIndex != null ? suggestions[highlightedIndex] : undefined;
    onConfirm(picked ?? value);
  };

  useEffect(() => {
    if (highlightedIndex == null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-suggestion-index="${highlightedIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

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
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={
            highlightedIndex != null ? `${listId}-option-${highlightedIndex}` : undefined
          }
          onChange={(e) => {
            setValue(e.target.value);
            setHighlightedIndex(null);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (suggestions.length === 0) return;
              e.preventDefault();
              e.stopPropagation();
              setHighlightedIndex((current) => {
                if (current == null) return e.key === "ArrowDown" ? 0 : suggestions.length - 1;
                const delta = e.key === "ArrowDown" ? 1 : -1;
                return (current + delta + suggestions.length) % suggestions.length;
              });
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              confirm();
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <button
          type="button"
          className="link-edit-option1-confirm"
          title="Confirm link"
          onClick={confirm}
          style={{ cursor: "pointer" }}
        >
          Confirm ⏎
        </button>
      </div>
      {suggestions.length > 0 ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="link-edit-option1-suggestions"
          style={{
            listStyle: "none",
            margin: "6px 0 0",
            padding: 0,
            maxHeight: VISIBLE_SUGGESTIONS * SUGGESTION_ROW_PX,
            overflowY: "auto",
          }}
        >
          {suggestions.map((path, index) => {
            const highlighted = index === highlightedIndex;
            return (
              <li key={path} role="presentation">
                <button
                  type="button"
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={highlighted}
                  data-suggestion-index={index}
                  // Mouse-down (not click) so the input's blur doesn't race the tooltip teardown.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onConfirm(path);
                  }}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  style={{
                    display: "block",
                    boxSizing: "border-box",
                    width: "100%",
                    height: SUGGESTION_ROW_PX,
                    textAlign: "left",
                    padding: "4px 6px",
                    border: "none",
                    background: highlighted ? "var(--crepe-color-hover, rgba(0, 0, 0, 0.06))" : "transparent",
                    cursor: "pointer",
                    fontSize: 12,
                    lineHeight: `${SUGGESTION_ROW_PX - 8}px`,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  className="link-edit-option1-suggestion"
                >
                  {path}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
