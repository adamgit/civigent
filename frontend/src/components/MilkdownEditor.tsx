/**
 * MilkdownEditor — adapter component for the Milkdown rich editor.
 *
 * Encapsulates @milkdown/crepe behind a stable public interface so that
 * Crepe can later be swapped for a manual Milkdown editor with ZERO
 * changes to consuming code.
 *
 * CRDT integration:
 *   When `crdtProvider` is passed, the editor binds to the Y.Doc via
 *   y-prosemirror (ySyncPlugin, yCursorPlugin, yUndoPlugin). The editor
 *   initializes from the Y.Doc state (not from the `markdown` prop),
 *   showing the live collaborative state.
 *
 *   The `fragmentKey` prop selects which Y.XmlFragment within the Y.Doc
 *   the editor binds to. Each section of a document has its own fragment
 *   keyed by section file ID (e.g. "section::sec_abc123def", "section::__root__").
 *
 * Public interface:
 *   Props:    markdown, onChange, onHeadingPathChange, readOnly,
 *             crdtProvider, fragmentKey, userName, userColor, onCursorExit
 *   Handle:   getMarkdown(), getActiveHeadingPath(), focus()
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
} from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/core";
import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import { TextSelection } from "@milkdown/prose/state";
import { ySyncPlugin, yCursorPlugin, yUndoPlugin } from "y-prosemirror";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

import { normalizeMarkdown, resolveHeadingPathFromDoc } from "./milkdown-utils";
import type { CrdtProvider } from "../services/crdt-provider";

// ─────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────

export interface MilkdownEditorHandle {
  /** Get markdown content, normalized through the shared serializer. */
  getMarkdown(): string;
  /** Get the heading path at the current selection. */
  getActiveHeadingPath(): string[];
  /** Focus this editor, placing cursor at start or end. */
  focus(position: "start" | "end"): void;
  /** Get the ProseMirror EditorView (for cross-section copy slicing). */
  getView(): import("@milkdown/prose/view").EditorView | null;
}

export interface MilkdownEditorProps {
  /** Initial markdown content (used only when no crdtProvider). */
  markdown: string;
  /** Called when the document content changes (debounced). */
  onChange?: (markdown: string) => void;
  /** Called when the selection moves to a different heading context. */
  onHeadingPathChange?: (headingPath: string[]) => void;
  /** Toggle read-only mode. */
  readOnly?: boolean;
  /** CRDT provider for collaborative editing. When set, editor binds to Y.Doc. */
  crdtProvider?: CrdtProvider | null;
  /** Y.XmlFragment key within the Y.Doc to bind to (e.g. "section::Overview"). */
  fragmentKey?: string;
  /** User's display name for cursor presence. */
  userName?: string;
  /** User's cursor color (CSS color string). */
  userColor?: string;
  /** Called when the cursor exits the editor boundary (ArrowUp at start, ArrowDown at end). */
  onCursorExit?: (direction: "up" | "down") => void;
}

// ─── Default cursor colors (assigned by hashing name) ────

const CURSOR_COLORS = [
  "#30bced", "#6eeb83", "#ffbc42", "#e84855",
  "#8ac926", "#ff6b6b", "#4ecdc4", "#a78bfa",
];

function pickColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

// ─────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────

export const MilkdownEditor = forwardRef(function MilkdownEditor(
  props: MilkdownEditorProps,
  ref: Ref<MilkdownEditorHandle>,
) {
  const {
    markdown,
    onChange,
    onHeadingPathChange,
    readOnly = false,
    crdtProvider,
    fragmentKey = "prosemirror",
    userName = "Anonymous",
    userColor,
    onCursorExit,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const readyRef = useRef(false);
  const deferredFocusRef = useRef<"start" | "end" | null>(null);
  const headingPathRef = useRef<string[]>([]);

  // Keep callback refs stable to avoid re-creating Crepe on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onHeadingPathChangeRef = useRef(onHeadingPathChange);
  onHeadingPathChangeRef.current = onHeadingPathChange;
  const onCursorExitRef = useRef(onCursorExit);
  onCursorExitRef.current = onCursorExit;

  // ── Focus helper (safe to call only after create() resolves) ──

  function doFocus(crepe: Crepe, position: "start" | "end"): void {
    const view = crepe.editor.ctx.get(editorViewCtx);
    view.focus();
    const { doc } = view.state;
    const pos = position === "start"
      ? 1
      : Math.max(1, doc.content.size - 1);
    const clampedPos = Math.max(1, Math.min(pos, doc.content.size - 1));
    const tr = view.state.tr.setSelection(
      TextSelection.create(doc, clampedPos),
    );
    view.dispatch(tr);
  }

  // ── Imperative handle ──────────────────────────────────

  useImperativeHandle(ref, () => ({
    getMarkdown(): string {
      const crepe = crepeRef.current;
      if (!crepe) return markdown;
      const raw = crepe.getMarkdown();
      return normalizeMarkdown(raw);
    },
    getActiveHeadingPath(): string[] {
      return headingPathRef.current;
    },
    focus(position: "start" | "end"): void {
      const crepe = crepeRef.current;
      if (!crepe) return;
      if (!readyRef.current) {
        // Editor still initializing — queue focus for when create() resolves.
        deferredFocusRef.current = position;
        return;
      }
      doFocus(crepe, position);
    },
    getView() {
      const crepe = crepeRef.current;
      if (!crepe || !readyRef.current) return null;
      try {
        return crepe.editor.ctx.get(editorViewCtx);
      } catch {
        return null;
      }
    },
  }));

  // ── Create / destroy Crepe ─────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // When CRDT provider is present, the editor initializes from the Y.Doc
    // (which already has the collaborative state). The `markdown` prop is
    // only used as fallback for non-collaborative mode.
    const crepe = new Crepe({
      root: container,
      defaultValue: crdtProvider ? "" : markdown,
      features: {
        [CrepeFeature.CodeMirror]: false,
        [CrepeFeature.ImageBlock]: false,
        [CrepeFeature.Latex]: false,
        [CrepeFeature.Placeholder]: true,
        [CrepeFeature.Toolbar]: true,
        [CrepeFeature.ListItem]: true,
        [CrepeFeature.LinkTooltip]: true,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.Cursor]: true,
        [CrepeFeature.Table]: true,
      },
    });

    // NOTE: y-prosemirror plugins (ySyncPlugin, yCursorPlugin, yUndoPlugin)
    // are NOT added here. They are added AFTER crepe.create() resolves via
    // ProseMirror's native reconfigure(). This is critical because
    // yCursorPlugin's plugin view immediately fires an awareness listener on
    // init, which queues a setTimeout dispatch. If that dispatch lands before
    // Milkdown finishes setting up its context system (editorState, etc.),
    // it throws "Context 'editorState' not found".

    // ── Cross-section cursor exit keymap ────────────────

    crepe.editor.use($prose(() => new Plugin({
      props: {
        handleKeyDown(view, event) {
          const exitCb = onCursorExitRef.current;
          if (!exitCb) return false;

          if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            const { $head } = view.state.selection;
            if ($head.pos <= 1) {
              exitCb("up");
              return true;
            }
          }
          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            const { $head } = view.state.selection;
            if ($head.pos >= view.state.doc.content.size - 1) {
              exitCb("down");
              return true;
            }
          }
          return false;
        },
      },
    })));

    // ── Listeners ──────────────────────────────────────

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    crepe.on((listener) => {
      // Content changes (debounced 300ms).
      listener.markdownUpdated((_ctx, md, _prevMd) => {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          onChangeRef.current?.(md);
        }, 300);
      });

      // Selection changes → heading path resolution.
      listener.selectionUpdated((_ctx, selection, _prevSelection) => {
        try {
          const doc = selection.$anchor.doc;
          const pos = selection.$anchor.pos;
          const newPath = resolveHeadingPathFromDoc(doc, pos);

          // Only notify if the path actually changed.
          const prev = headingPathRef.current;
          if (
            newPath.length !== prev.length ||
            newPath.some((seg, i) => seg !== prev[i])
          ) {
            headingPathRef.current = newPath;
            onHeadingPathChangeRef.current?.(newPath);
          }
        } catch {
          // Defensive: don't let heading resolution errors break the editor.
        }
      });
    });

    // ── Mount ──────────────────────────────────────────

    crepeRef.current = crepe;
    readyRef.current = false;
    deferredFocusRef.current = null;

    crepe.create().then(() => {
      // Guard: if this Crepe instance was already torn down, bail.
      if (crepeRef.current !== crepe) return;

      // ── Attach y-prosemirror plugins AFTER Milkdown context is ready ──
      // We use ProseMirror's native reconfigure() so the plugins are added
      // to the existing EditorView without going through Milkdown's async
      // plugin loader. By this point all Milkdown contexts (editorState,
      // etc.) are fully initialized, so y-prosemirror's eager awareness
      // dispatch won't crash.
      if (crdtProvider) {
        const view = crepe.editor.ctx.get(editorViewCtx);
        const yXmlFragment = crdtProvider.doc.getXmlFragment(fragmentKey);
        const awareness = crdtProvider.awareness;
        const color = userColor ?? pickColor(userName);

        const newState = view.state.reconfigure({
          plugins: [
            ...view.state.plugins,
            ySyncPlugin(yXmlFragment),
            yCursorPlugin(awareness),
            yUndoPlugin(),
          ],
        });
        view.updateState(newState);

        // Set awareness AFTER plugins are active so listeners are registered.
        // viewingPresence: include fragmentKey so other users see which section
        // we're viewing from the earliest moment of interaction.
        awareness.setLocalStateField("user", {
          name: userName,
          color,
          viewingSections: [fragmentKey],
        });
      }

      readyRef.current = true;

      // If focus() was called while we were initializing, fire it now.
      const pendingPos = deferredFocusRef.current;
      if (pendingPos) {
        deferredFocusRef.current = null;
        doFocus(crepe, pendingPos);
      }
    }).catch((err) => {
      throw err;
    });

    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      readyRef.current = false;
      deferredFocusRef.current = null;
      crepeRef.current = null;
      void crepe.destroy();
    };
    // crdtProvider and fragmentKey in deps: remount if CRDT connection or fragment changes.
    // markdown intentionally excluded — only used as initial value for non-CRDT mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crdtProvider, fragmentKey]);

  // ── Read-only toggling ─────────────────────────────────

  useEffect(() => {
    const crepe = crepeRef.current;
    if (crepe) crepe.setReadonly(readOnly);
  }, [readOnly]);

  // ── Render ─────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={{ width: "100%" }}
    />
  );
});
