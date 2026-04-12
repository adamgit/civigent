/**
 * MilkdownEditor — adapter component for the Milkdown rich editor.
 *
 * Encapsulates @milkdown/crepe behind a stable public interface so that
 * Crepe can later be swapped for a manual Milkdown editor with ZERO
 * changes to consuming code.
 *
 * CRDT integration:
 *   When `store` (BrowserFragmentReplicaStore) is passed, the editor
 *   binds to `store.doc` via y-prosemirror (ySyncPlugin, yCursorPlugin,
 *   yUndoPlugin). The editor initializes from the Y.Doc state (not from
 *   the `markdown` prop), showing the live collaborative state.
 *
 *   The `fragmentKey` prop selects which Y.XmlFragment within the Y.Doc
 *   the editor binds to. Each section of a document has its own fragment
 *   keyed by section file ID (e.g. "section::sec_abc123def", "section::__beforeFirstHeading__").
 *
 * Public interface:
 *   Props:    markdown, onChange, onHeadingPathChange, readOnly,
 *             store, transport, fragmentKey, userName, userColor, onCursorExit
 *   Handle:   getMarkdown(), getActiveHeadingPath(), focus()
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
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
import { proseMirrorNodeToMarkdown } from "@ks/milkdown-serializer";
import { pmPosToMarkdownOffset } from "../services/drop-position";
import type { SectionTransfer } from "../services/section-transfer";
import { EditorLifecycleController } from "../services/editor-lifecycle";

// ─── Module-level drag source tracking ───────────────────
// Only one drag can be active at a time, so a module-level
// variable is safe. Set on dragstart, cleared on dragend.

export interface DragSourceInfo {
  fragmentKey: string;
  from: number;
  to: number;
  /** Reference to the source ProseMirror view for deletion after cross-section drop. */
  view: import("@milkdown/prose/view").EditorView;
}

export let dragSourceInfo: DragSourceInfo | null = null;

/**
 * Custom cursor builder for yCursorPlugin.
 * Renders a zero-width inline <span> with a left-border caret and an
 * absolutely-positioned name label above it. This eliminates the phantom
 * newlines caused by the default <div> name label inside inline text flow.
 */
function buildCollabCursor(user: { name?: string; color?: string }): HTMLElement {
  const cursor = document.createElement("span");
  cursor.className = "collab-cursor";
  cursor.style.borderLeftColor = user.color ?? "#999";

  const label = document.createElement("span");
  label.className = "collab-cursor-label";
  label.style.backgroundColor = user.color ?? "#999";
  label.textContent = user.name ?? "Anonymous";
  cursor.appendChild(label);

  return cursor;
}
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";

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
  /** Focus this editor, placing caret at the given viewport coordinates.
   *  Falls back to focus("start") if coords don't resolve to a position.
   *  Must only be called when editor is ready AND visible. */
  focusAtCoords(x: number, y: number): void;
  /** Get the ProseMirror EditorView (for cross-section copy slicing). */
  getView(): import("@milkdown/prose/view").EditorView | null;
}

export interface MilkdownEditorProps {
  /** Initial markdown content (used only when no store). */
  markdown: string;
  /** Called when the document content changes (debounced). */
  onChange?: (markdown: string) => void;
  /** Called when the selection moves to a different heading context. */
  onHeadingPathChange?: (headingPath: string[]) => void;
  /** Toggle read-only mode. */
  readOnly?: boolean;
  /** Fragment replica store for collaborative editing. When set, editor binds to store.doc. */
  store?: BrowserFragmentReplicaStore | null;
  /** CRDT transport for wire-side calls (overlay import requests, etc.). */
  transport?: CrdtTransport | null;
  /** Whether the CRDT transport has completed initial sync (Y.Doc has content). */
  crdtSynced?: boolean;
  /** Y.XmlFragment key within the Y.Doc to bind to (e.g. "section::Overview"). */
  fragmentKey?: string;
  /** User's display name for cursor presence. */
  userName?: string;
  /** User's cursor color (CSS color string). */
  userColor?: string;
  /** Called when the cursor exits the editor boundary (ArrowUp at start, ArrowDown at end). */
  onCursorExit?: (direction: "up" | "down") => void;
  /** Called when content is dropped from a different section's editor. */
  onCrossSectionDrop?: (transfer: SectionTransfer) => void;
  /** Called when the editor is fully initialized and has content (safe to display). */
  onReady?: () => void;
  /** Called when the editor is being destroyed (cleanup). */
  onUnready?: () => void;
  /** When true, editor starts empty and waits for CRDT sync to populate content.
   *  Prevents phantom edits from REST→CRDT normalization delta on mount. */
  expectsCrdt?: boolean;
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
    store,
    transport,
    crdtSynced = false,
    fragmentKey = "prosemirror",
    userName = "Anonymous",
    userColor,
    onCursorExit,
    onCrossSectionDrop,
    onReady,
    onUnready,
    expectsCrdt = false,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<EditorLifecycleController | null>(null);
  const deferredFocusRef = useRef<"start" | "end" | null>(null);
  const headingPathRef = useRef<string[]>([]);

  // Refs for async callbacks that need current prop values
  const storeRef = useRef(store);
  storeRef.current = store;
  const crdtSyncedRef = useRef(crdtSynced);
  crdtSyncedRef.current = crdtSynced;

  // Keep callback refs stable to avoid re-creating Crepe on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onHeadingPathChangeRef = useRef(onHeadingPathChange);
  onHeadingPathChangeRef.current = onHeadingPathChange;
  const onCursorExitRef = useRef(onCursorExit);
  onCursorExitRef.current = onCursorExit;
  const onCrossSectionDropRef = useRef(onCrossSectionDrop);
  onCrossSectionDropRef.current = onCrossSectionDrop;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onUnreadyRef = useRef(onUnready);
  onUnreadyRef.current = onUnready;
  const [ready, setReady] = useState(false);

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
      const ctrl = controllerRef.current;
      const crepe = ctrl?.getCrepe();
      if (!crepe || !ctrl?.isReady()) return markdown;
      const raw = crepe.getMarkdown();
      return normalizeMarkdown(raw);
    },
    getActiveHeadingPath(): string[] {
      return headingPathRef.current;
    },
    focus(position: "start" | "end"): void {
      const ctrl = controllerRef.current;
      const crepe = ctrl?.getCrepe();
      if (!crepe) return;
      if (!ctrl?.isReady()) {
        deferredFocusRef.current = position;
        return;
      }
      doFocus(crepe, position);
    },
    focusAtCoords(x: number, y: number): void {
      const ctrl = controllerRef.current;
      const crepe = ctrl?.getCrepe();
      if (!crepe || !ctrl?.isReady()) return;
      const view = crepe.editor.ctx.get(editorViewCtx);
      const posResult = view.posAtCoords({ left: x, top: y });
      if (posResult) {
        const { doc } = view.state;
        const pos = Math.max(1, Math.min(posResult.pos, doc.content.size - 1));
        const tr = view.state.tr.setSelection(TextSelection.create(doc, pos));
        view.dispatch(tr);
        view.focus();
      } else {
        doFocus(crepe, "start");
      }
    },
    getView() {
      const ctrl = controllerRef.current;
      const crepe = ctrl?.getCrepe();
      if (!crepe || !ctrl?.isReady()) return null;
      try {
        return crepe.editor.ctx.get(editorViewCtx);
      } catch {
        return null;
      }
    },
  }));

  // ── CRDT attachment (called by controller transitions) ──

  function attachCrdt(
    ctrl: EditorLifecycleController,
    crepe: Crepe,
    replicaStore: BrowserFragmentReplicaStore,
    fk: string,
  ): void {
    const view = crepe.editor.ctx.get(editorViewCtx);
    ctrl.setBasePlugins([...view.state.plugins]);

    const yXmlFragment = replicaStore.doc.getXmlFragment(fk);
    const awareness = replicaStore.awareness;
    const color = userColor ?? pickColor(userName);

    const newState = view.state.reconfigure({
      plugins: [
        ...view.state.plugins,
        ySyncPlugin(yXmlFragment),
        yCursorPlugin(awareness, { cursorBuilder: buildCollabCursor }),
        yUndoPlugin(),
      ],
    });
    view.updateState(newState);

    awareness.setLocalStateField("user", {
      name: userName,
      color,
      viewingSections: [fk],
    });

    ctrl.setCrdtAttached(true);
    ctrl.send("attach_done");
  }

  function detachCrdt(ctrl: EditorLifecycleController): void {
    const crepe = ctrl.getCrepe();
    if (!crepe || !ctrl.crdtAttached) return;
    try {
      const view = crepe.editor.ctx.get(editorViewCtx);
      const newState = view.state.reconfigure({ plugins: ctrl.basePlugins });
      view.updateState(newState);
    } catch {
      // Editor might be mid-destroy — nothing to detach.
    }
    ctrl.setCrdtAttached(false);
  }

  function markReady(crepe: Crepe): void {
    setReady(true);
    onReadyRef.current?.();

    const pendingPos = deferredFocusRef.current;
    if (pendingPos) {
      deferredFocusRef.current = null;
      doFocus(crepe, pendingPos);
    }
  }

  // ── Effect A: Crepe lifecycle (deps: [fragmentKey]) ────
  // Creates controller + Crepe. Cleanup sends `unmount`.

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ctrl = new EditorLifecycleController(fragmentKey);
    controllerRef.current = ctrl;
    ctrl.send("start_create");

    const crepe = new Crepe({
      root: container,
      defaultValue: expectsCrdt ? "" : markdown,
      features: {
        [CrepeFeature.CodeMirror]: false,
        [CrepeFeature.ImageBlock]: false,
        [CrepeFeature.Latex]: false,
        [CrepeFeature.Placeholder]: false,
        [CrepeFeature.Toolbar]: true,
        [CrepeFeature.ListItem]: false,
        [CrepeFeature.LinkTooltip]: true,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.Cursor]: true,
        [CrepeFeature.Table]: true,
      },
    });
    ctrl.setCrepe(crepe);

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

    // ── Drag-source tracking ─────────────────────────────

    const fragmentKeyCapture = fragmentKey;
    crepe.editor.use($prose(() => new Plugin({
      props: {
        handleDOMEvents: {
          dragstart(view) {
            const { from, to } = view.state.selection;
            dragSourceInfo = { fragmentKey: fragmentKeyCapture, from, to, view };
            return false;
          },
          dragend() {
            dragSourceInfo = null;
            return false;
          },
        },
      },
    })));

    // ── Cross-section drop interception ────────────────

    crepe.editor.use($prose(() => new Plugin({
      props: {
        handleDrop(view, event) {
          const dropCb = onCrossSectionDropRef.current;
          if (!dropCb || !event) return false;

          const source = dragSourceInfo;
          if (!source || source.fragmentKey === fragmentKeyCapture) return false;

          event.preventDefault();

          const dt = event.dataTransfer;
          const plainText = dt?.getData("text/plain") ?? "";

          const sourceView = source.view;
          const sourceFrom = source.from;
          const sourceTo = source.to;
          const slice = sourceView.state.doc.slice(sourceFrom, sourceTo);
          const docNode = sourceView.state.doc.type.create(null, slice.content);
          const md = proseMirrorNodeToMarkdown(docNode);

          const deleteSourceCallback = () => {
            const tr = sourceView.state.tr.delete(sourceFrom, sourceTo);
            sourceView.dispatch(tr);
          };

          let insertionOffset: number | undefined;
          const posResult = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (posResult) {
            const targetMarkdown = proseMirrorNodeToMarkdown(view.state.doc);
            insertionOffset = pmPosToMarkdownOffset(view, posResult.pos, targetMarkdown);
          }

          const transfer: SectionTransfer = {
            sourceFragmentKey: source.fragmentKey,
            sourceHeadingPath: [],
            targetFragmentKey: fragmentKeyCapture,
            targetHeadingPath: [],
            content: { markdown: md, plainText },
            sourceSliceRange: { from: sourceFrom, to: sourceTo },
            deleteFromSource: true,
            insertionOffset,
            deleteSourceCallback,
          };

          dropCb(transfer);
          dragSourceInfo = null;
          return true;
        },
      },
    })));

    // ── Listeners ──────────────────────────────────────

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, md, _prevMd) => {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          onChangeRef.current?.(md);
        }, 300);
      });

      listener.selectionUpdated((_ctx, selection, _prevSelection) => {
        try {
          const doc = selection.$anchor.doc;
          const pos = selection.$anchor.pos;
          const newPath = resolveHeadingPathFromDoc(doc, pos);

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

    deferredFocusRef.current = null;

    let cleanupDragListeners: (() => void) | null = null;

    crepe.create().then(() => {
      if (controllerRef.current !== ctrl) return;
      ctrl.send("crepe_created");

      // Native dragstart/dragend on container for BlockEdit handle
      const view = crepe.editor.ctx.get(editorViewCtx);
      const onDragStart = (e: Event) => {
        const target = (e as DragEvent).target as HTMLElement;
        if (!target.closest?.(".milkdown-block-handle")) return;
        const { from, to } = view.state.selection;
        dragSourceInfo = { fragmentKey: fragmentKeyCapture, from, to, view };
      };
      const onDragEnd = () => { dragSourceInfo = null; };
      container.addEventListener("dragstart", onDragStart as EventListener);
      container.addEventListener("dragend", onDragEnd);
      cleanupDragListeners = () => {
        container.removeEventListener("dragstart", onDragStart as EventListener);
        container.removeEventListener("dragend", onDragEnd);
      };

      // Catch up with state that arrived while Crepe was creating.
      // Effects B/C may have fired while state was "creating" and were no-ops.
      // Read from refs to get current prop values (not stale closure values).
      const currentStore = storeRef.current;
      if (currentStore && ctrl.state === "created") {
        ctrl.send("crdt_provider_set");
        if (crdtSyncedRef.current) {
          ctrl.send("crdt_synced");
          attachCrdt(ctrl, crepe, currentStore, fragmentKeyCapture);
          markReady(crepe);
        }
      } else if (!currentStore && ctrl.state === "created") {
        // No CRDT store — editor is ready immediately
        markReady(crepe);
      }
    }).catch((err) => {
      throw err;
    });

    return () => {
      cleanupDragListeners?.();
      if (debounceTimer !== null) clearTimeout(debounceTimer);

      // Silence ProseMirror dispatch before async crepe.destroy() starts.
      try {
        const view = crepe.editor.ctx.get(editorViewCtx);
        view.dispatch = () => {};
      } catch {
        // Editor might not be fully created yet.
      }

      ctrl.send("unmount");
      controllerRef.current = null;
      setReady(false);
      onUnreadyRef.current?.();
      deferredFocusRef.current = null;
      void crepe.destroy();
    };
    // markdown intentionally excluded — only used as initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragmentKey]);

  // ── Effect B: Store change (deps: [store]) ──
  // Sends crdt_provider_set or crdt_provider_removed to controller.

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;

    if (store) {
      // Only send if controller is in a state that accepts this event
      if (ctrl.state === "created") {
        ctrl.send("crdt_provider_set");
      }
    }

    return () => {
      const c = controllerRef.current;
      if (c && store && (c.state === "awaiting_sync" || c.state === "ready")) {
        detachCrdt(c);
        c.send("crdt_provider_removed");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // ── Effect C: crdtSynced gate (deps: [crdtSynced]) ────
  // When crdtSynced transitions to true, triggers CRDT attachment.

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || !crdtSynced || !store) return;
    if (ctrl.state !== "awaiting_sync") return;

    const crepe = ctrl.getCrepe();
    if (!crepe) return;

    ctrl.send("crdt_synced");
    // Now in "attaching" — perform the actual attachment
    attachCrdt(ctrl, crepe, store, fragmentKey);
    // attachCrdt sends "attach_done" → state is now "ready"
    markReady(crepe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crdtSynced]);

  // ── Read-only toggling ─────────────────────────────────

  useEffect(() => {
    const crepe = controllerRef.current?.getCrepe();
    if (crepe) crepe.setReadonly(readOnly);
  }, [readOnly]);

  // ── Render ─────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={{ visibility: ready ? "visible" : "hidden" }}
    />
  );
});
