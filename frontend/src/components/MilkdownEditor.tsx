/**
 * MilkdownEditor — adapter component for the Milkdown rich editor.
 *
 * Encapsulates @milkdown/crepe behind a stable public interface so that
 * Crepe can later be swapped for a manual Milkdown editor with ZERO
 * changes to consuming code.
 *
 * CRDT integration:
 *   When a `LiveEditorBinding` is passed, the editor binds to the replica's
 *   Y.Doc via y-prosemirror (ySyncPlugin, yCursorPlugin, yUndoPlugin). The
 *   editor initializes from the Y.Doc state (not from a markdown seed),
 *   showing the live collaborative state. The binding carries the fragment
 *   key selecting which Y.XmlFragment within the Y.Doc the editor binds to.
 *
 * Public interface:
 *   Props:    markdown (cold) | binding (live), onChange, onHeadingPathChange,
 *             readOnly, userName, userColor, onCursorExit
 *   Handle:   getMarkdown(), getActiveHeadingPath(), focus()
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/core";
import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import { TextSelection } from "@milkdown/prose/state";
import { ySyncPlugin, ySyncPluginKey, yCursorPlugin, yUndoPlugin } from "y-prosemirror";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

import { normalizeMarkdown, resolveHeadingPathFromDoc } from "./milkdown-utils";
import type { SectionTransfer, DropVerdict } from "../services/section-transfer";
import { crossSectionDropPlugin, setDragSourceInfo } from "./crossSectionDropPlugin";
import { crossSectionNavigationPlugin } from "./crossSectionNavigationPlugin";
import { editorSessionCommandsPlugin } from "./editorSessionCommandsPlugin";
import { documentBoundaryPlugin } from "./documentBoundaryPlugin";
import { caretScrollClearancePlugin } from "./caretScrollClearancePlugin";
import { vscodeMarkdownPasteFix } from "./vscodeMarkdownPasteFix";
import { listGutterSwipePlugin } from "./listGutterSwipePlugin";
import { useEditorSessionCommands } from "../contexts/EditorSessionCommandsContext";
import { EditorLifecycleController } from "../services/editor-lifecycle";
import { installAttachEchoGuard } from "../services/ysync-attach-echo-guard";
import { FirstSyncReadyLatch } from "../services/first-sync-ready-latch";
import { installLinkPicker } from "./link-picker/install-link-picker";
import { installLinkHrefBridge } from "./install-link-href-bridge";

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
import { unwrapLiveEditorBindingForMilkdown, type LiveEditorBinding } from "../services/live-section-replica";

interface EditorFragmentSource {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
}

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
  focusAtPos(pos: number): void;
  /** Get the ProseMirror EditorView (for cross-section copy slicing). */
  getView(): import("@milkdown/prose/view").EditorView | null;
}

export interface MilkdownEditorCommonProps {
  /** Called when the document content changes (debounced). */
  onChange?: (markdown: string) => void;
  /** Called when the selection moves to a different heading context. */
  onHeadingPathChange?: (headingPath: string[]) => void;
  /** Toggle read-only mode. */
  readOnly?: boolean;
  /** User's display name for cursor presence. */
  userName?: string;
  /** User's cursor color (CSS color string). */
  userColor?: string;
  /** Called when the cursor exits the editor boundary (ArrowUp at start, ArrowDown at end). */
  onCursorExit?: (direction: "up" | "down") => void;
  onDocumentBoundary?: (boundary: "start" | "end") => void;
  /** Advisory pre-drop check for cross-section drags.
   *  Called during dragover to gate whether this editor should accept a drop.
   *  When absent, all drops are permitted (browser default for contentEditable). */
  canDrop?: () => DropVerdict;
  /** Called when content is dropped from a different section's editor. */
  onCrossSectionDrop?: (transfer: SectionTransfer) => void;
  /** Called on a GENUINE local edit to the bound fragment (this session's own
   *  typing/paste/IME/drop), never on a remote or programmatic Y.Doc apply.
   *  Sourced from the editor's native `beforeinput` event, which fires only for
   *  real user input and not for ProseMirror/ySync's programmatic DOM updates.
   *  CRDT mode only. */
  onLocalEdit?: () => void;
  /** Called when the editor is fully initialized and has content (safe to display). */
  onReady?: () => void;
  /** Called when the editor is being destroyed (cleanup). */
  onUnready?: () => void;
}

export interface MilkdownEditorColdProps extends MilkdownEditorCommonProps {
  expectsCrdt?: false;
  markdown: string;
  binding?: never;
}

export interface MilkdownEditorLiveProps extends MilkdownEditorCommonProps {
  expectsCrdt: true;
  binding: LiveEditorBinding;
  markdown?: never;
}

export type MilkdownEditorProps = MilkdownEditorColdProps | MilkdownEditorLiveProps;

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

export const MilkdownEditor = forwardRef(function MilkdownEditor(
  props: MilkdownEditorProps,
  ref: Ref<MilkdownEditorHandle>,
) {
  const {
    markdown = "",
    onChange,
    onHeadingPathChange,
    readOnly = false,
    userName = "Anonymous",
    userColor,
    onCursorExit,
    onDocumentBoundary,
    canDrop,
    onCrossSectionDrop,
    onLocalEdit,
    onReady,
    onUnready,
    expectsCrdt = false,
    binding,
  } = props;

  const attach = binding ? unwrapLiveEditorBindingForMilkdown(binding) : null;
  const attachDoc = attach?.doc;
  const attachAwareness = attach?.awareness;
  const effectiveStore = useMemo<EditorFragmentSource | null>(() => {
    if (attachDoc && attachAwareness) {
      return { doc: attachDoc, awareness: attachAwareness };
    }
    return null;
  }, [attachDoc, attachAwareness]);
  const effectiveFragmentKey = attach ? attach.fragmentKey : "prosemirror";
  const effectiveCrdtSynced = binding != null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<EditorLifecycleController | null>(null);
  const deferredFocusRef = useRef<"start" | "end" | null>(null);
  const headingPathRef = useRef<string[]>([]);
  // Cleanup for the native `beforeinput` listener that surfaces genuine local
  // edits. Held so it can be removed on CRDT-detach and on unmount, so a leaked
  // listener never fires against a destroyed component.
  const localEditListenerCleanupRef = useRef<(() => void) | null>(null);
  // First-sync readiness latch + its empty-fragment fallback rAF. Held so detach
  // / unmount during the post-attach await window can cancel both and never mark
  // a torn-down editor ready.
  const firstSyncLatchRef = useRef<FirstSyncReadyLatch | null>(null);
  const firstSyncFallbackRafRef = useRef<number | null>(null);

  // Refs for async callbacks that need current prop values
  const storeRef = useRef<EditorFragmentSource | null>(effectiveStore);
  storeRef.current = effectiveStore;
  const crdtSyncedRef = useRef(effectiveCrdtSynced);
  crdtSyncedRef.current = effectiveCrdtSynced;

  // Keep callback refs stable to avoid re-creating Crepe on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onHeadingPathChangeRef = useRef(onHeadingPathChange);
  onHeadingPathChangeRef.current = onHeadingPathChange;
  const onCursorExitRef = useRef(onCursorExit);
  onCursorExitRef.current = onCursorExit;
  const onDocumentBoundaryRef = useRef(onDocumentBoundary);
  onDocumentBoundaryRef.current = onDocumentBoundary;
  const editorSessionCommands = useEditorSessionCommands();
  const editorSessionCommandsRef = useRef(editorSessionCommands);
  editorSessionCommandsRef.current = editorSessionCommands;
  const canDropRef = useRef(canDrop);
  canDropRef.current = canDrop;
  const onCrossSectionDropRef = useRef(onCrossSectionDrop);
  onCrossSectionDropRef.current = onCrossSectionDrop;
  const onLocalEditRef = useRef(onLocalEdit);
  onLocalEditRef.current = onLocalEdit;
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
    focusAtPos(pos: number): void {
      const ctrl = controllerRef.current;
      const crepe = ctrl?.getCrepe();
      if (!crepe || !ctrl?.isReady()) return;
      const view = crepe.editor.ctx.get(editorViewCtx);
      const { doc } = view.state;
      const clamped = Math.max(0, Math.min(pos, doc.content.size));
      const selection = TextSelection.near(doc.resolve(clamped));
      view.dispatch(view.state.tr.setSelection(selection));
      view.focus();
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
    replicaStore: EditorFragmentSource,
    fk: string,
  ): void {
    const view = crepe.editor.ctx.get(editorViewCtx);
    ctrl.setBasePlugins([...view.state.plugins]);

    const yXmlFragment = replicaStore.doc.getXmlFragment(fk);
    const awareness = replicaStore.awareness;
    const color = userColor ?? pickColor(userName);

    // Surface GENUINE local edits to this fragment. The producer is the editor's
    // native `beforeinput` event, which fires only for real user input (typing,
    // paste, IME, drop) and NEVER for ProseMirror/ySync's programmatic DOM
    // updates when binding or applying a remote frame. Yjs `transaction.local`
    // was the previous discriminator but it is wrong: attach-time awareness/sync
    // transactions also run as `local=true` (proven at runtime — the awareness
    // listener writes back via a deferred dispatch), polluting the session
    // authorship ledger on open and mislabelling an inbound update as your save.
    teardownLocalEditObserver();
    const editorDom = view.dom;
    let disarmEchoGuard: () => void = () => {};
    const localEditHandler = (): void => {
      disarmEchoGuard();
      onLocalEditRef.current?.();
    };
    editorDom.addEventListener("beforeinput", localEditHandler);
    localEditListenerCleanupRef.current = () => {
      editorDom.removeEventListener("beforeinput", localEditHandler);
      localEditListenerCleanupRef.current = null;
    };

    // Readiness must wait until ySync has actually rendered this fragment's
    // content into the editor — y-prosemirror populates on a DEFERRED dispatch,
    // so flipping `isReady` at attach time exposes an empty editor for one frame
    // (the click-to-edit height jump). The latch fires markReady once the first
    // ySync content transaction is seen (detector below) or, for a genuinely-
    // empty fragment that emits none, via the rAF fallback armed after attach.
    teardownFirstSyncLatch();
    const latch = new FirstSyncReadyLatch(() => {
      // Defer the React/FSM work out of the ProseMirror dispatch that triggered
      // the detector, and re-check liveness across that gap.
      queueMicrotask(() => {
        if (controllerRef.current !== ctrl || ctrl.state !== "attached") return;
        ctrl.send("content_synced");
        markReady(crepe);
      });
    });
    firstSyncLatchRef.current = latch;
    const firstSyncDetector = new Plugin({
      appendTransaction: (trs, _oldState, _newState) => {
        latch.noteTransactions(trs, ySyncPluginKey);
        return null;
      },
    });

    const newState = view.state.reconfigure({
      plugins: [
        ...view.state.plugins,
        ySyncPlugin(yXmlFragment),
        yCursorPlugin(awareness, { cursorBuilder: buildCollabCursor }),
        yUndoPlugin(),
        firstSyncDetector,
      ],
    });
    disarmEchoGuard = installAttachEchoGuard(
      ySyncPluginKey.getState(newState),
      replicaStore.doc,
      fk,
    );
    view.updateState(newState);

    awareness.setLocalStateField("user", {
      name: userName,
      color,
      viewingSections: [fk],
    });

    ctrl.setCrdtAttached(true);
    ctrl.send("attach_done");

    // Empty-fragment fallback: a fragment that emits no ySync content transaction
    // would never trip the detector, so mark ready after one frame (the editor is
    // already settled to empty). Idempotent with the detector via the latch.
    if (typeof requestAnimationFrame === "function") {
      firstSyncFallbackRafRef.current = requestAnimationFrame(() => {
        firstSyncFallbackRafRef.current = null;
        latch.fallback();
      });
    } else {
      latch.fallback();
    }
  }

  function teardownLocalEditObserver(): void {
    localEditListenerCleanupRef.current?.();
  }

  /** Cancel a pending first-sync readiness latch + its fallback rAF (so neither
   *  marks a detached/unmounted editor ready). */
  function teardownFirstSyncLatch(): void {
    firstSyncLatchRef.current?.cancel();
    firstSyncLatchRef.current = null;
    if (firstSyncFallbackRafRef.current !== null) {
      cancelAnimationFrame(firstSyncFallbackRafRef.current);
      firstSyncFallbackRafRef.current = null;
    }
  }

  function detachCrdt(ctrl: EditorLifecycleController): void {
    teardownLocalEditObserver();
    teardownFirstSyncLatch();
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

    const ctrl = new EditorLifecycleController(effectiveFragmentKey);
    controllerRef.current = ctrl;
    ctrl.send("start_create");

    // Each Crepe instance mounts into its OWN root element under `container`,
    // created synchronously here. This lets cleanup remove exactly THIS
    // instance's DOM synchronously — even if the async `crepe.create()` has not
    // mounted yet (StrictMode double-invoke / rapid remount). A `create()` that
    // resolves after cleanup then mounts into an already-detached node, so it
    // contributes no layout and two editors can never stack in the container.
    const editorRoot = document.createElement("div");
    container.appendChild(editorRoot);

    const crepe = new Crepe({
      root: editorRoot,
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
    crepe.editor.config(vscodeMarkdownPasteFix);
    ctrl.setCrepe(crepe);

    // ── Link document-path picker ─────────────────────────
    // Replaces the stock link-edit tooltip with the React popup that offers
    // workspace document-path autocomplete (runs after Crepe's LinkTooltip configure).
    installLinkPicker(crepe.editor);

    installLinkHrefBridge(crepe.editor);

    // ── Cross-section cursor exit keymap ────────────────

    crepe.editor.use(crossSectionNavigationPlugin({ onCursorExitRef }));

    crepe.editor.use(documentBoundaryPlugin({ onDocumentBoundaryRef }));

    crepe.editor.use(caretScrollClearancePlugin());

    // ── Host/session command chords ─────────────────────

    crepe.editor.use(editorSessionCommandsPlugin({ commandsRef: editorSessionCommandsRef }));

    // ── Touch list nesting ──────────────────────────────

    crepe.editor.use(listGutterSwipePlugin());

    // ── Task-list checkbox toggle ────────────────────────
    // ListItem Crepe feature stays off (native <li> bullet parity). GFM still
    // owns checked attrs + the "[ ] "/"[x] " input rule; this click handler is
    // the interactive stand-in for Crepe's checkbox node view.
    crepe.editor.use($prose(() => new Plugin({
      props: {
        handleDOMEvents: {
          mousedown(view, event) {
            if (!view.editable || event.button !== 0) return false;
            const target = event.target;
            if (!(target instanceof Element)) return false;
            const li = target.closest("li[data-item-type=\"task\"]");
            if (!(li instanceof HTMLElement) || !view.dom.contains(li)) return false;

            const rect = li.getBoundingClientRect();
            // ::before checkbox sits in the ul gutter just left of the li content.
            if (event.clientX < rect.left - 20 || event.clientX > rect.left + 2) return false;

            const pos = view.posAtDOM(li, 0);
            const $pos = view.state.doc.resolve(pos);
            let depth = $pos.depth;
            while (depth > 0 && $pos.node(depth).type.name !== "list_item") depth--;
            if (depth === 0) return false;

            const node = $pos.node(depth);
            if (node.attrs.checked == null) return false;

            event.preventDefault();
            view.dispatch(
              view.state.tr.setNodeMarkup($pos.before(depth), undefined, {
                ...node.attrs,
                checked: !node.attrs.checked,
              }),
            );
            return true;
          },
        },
      },
    })));

    // ── Cross-section drag/drop plugin ──────────────────

    const fragmentKeyCapture = effectiveFragmentKey;
    crepe.editor.use(crossSectionDropPlugin({
      fragmentKey: fragmentKeyCapture,
      canDropRef,
      onCrossSectionDropRef,
    }));

    // ── Listeners ──────────────────────────────────────

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    crepe.on((listener) => {
      // markdownUpdated serializes the whole editor doc on every transaction.
      // Live CRDT editors never consume onChange (y-prosemirror is the source
      // of truth), so subscribing would stall every keystroke for no reason.
      if (!expectsCrdt) {
        listener.markdownUpdated((_ctx, md, _prevMd) => {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            onChangeRef.current?.(md);
          }, 300);
        });
      }

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

    const createPromise = crepe.create();
    createPromise.then(() => {
      if (controllerRef.current !== ctrl) return;
      ctrl.send("crepe_created");

      // Native dragstart/dragend on container for BlockEdit handle
      const view = crepe.editor.ctx.get(editorViewCtx);
      const onDragStart = (e: Event) => {
        const target = (e as DragEvent).target as HTMLElement;
        if (!target.closest?.(".milkdown-block-handle")) return;
        const { from, to } = view.state.selection;
        setDragSourceInfo({ fragmentKey: fragmentKeyCapture, from, to, view });
      };
      const onDragEnd = () => { setDragSourceInfo(null); };
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
          // attachCrdt now defers markReady to the first-sync latch (the editor is
          // marked ready only once ySync has rendered content, or via fallback).
          attachCrdt(ctrl, crepe, currentStore, fragmentKeyCapture);
        }
      } else if (!currentStore && ctrl.state === "created") {
        // No live binding — cold editor is ready immediately
        markReady(crepe);
      }
    }).catch((err) => {
      if (controllerRef.current === ctrl) {
        throw err;
      }
    });

    return () => {
      cleanupDragListeners?.();
      detachCrdt(ctrl);
      if (debounceTimer !== null) clearTimeout(debounceTimer);

      // Silence ProseMirror dispatch before async crepe.destroy() starts.
      try {
        const view = crepe.editor.ctx.get(editorViewCtx);
        view.dispatch = () => {};
      } catch {
        // Editor might not be fully created yet.
      }

      // Synchronously remove THIS instance's root from layout. Because each
      // instance owns its own `editorRoot` (not the shared `container`), this
      // removes exactly this editor and never touches a sibling remount's root.
      // crepe.destroy() resolves on a later tick; if the async create() is still
      // in flight it will mount into this now-detached node (zero layout), so a
      // StrictMode double-invoke / rapid remount can never stack two roots.
      editorRoot.remove();

      ctrl.send("unmount");
      controllerRef.current = null;
      setReady(false);
      onUnreadyRef.current?.();
      deferredFocusRef.current = null;
      void createPromise
        .catch(() => undefined)
        .then(() => crepe.destroy())
        .catch(() => undefined);
    };
    // markdown intentionally excluded — only used as initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFragmentKey]);

  // ── Effect B: Binding change (deps: [effectiveStore]) ──
  // Sends crdt_provider_set or crdt_provider_removed to controller.

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;

    if (effectiveStore) {
      // Only send if controller is in a state that accepts this event
      if (ctrl.state === "created") {
        ctrl.send("crdt_provider_set");
      }
    }

    return () => {
      const c = controllerRef.current;
      if (c && effectiveStore && (c.state === "awaiting_sync" || c.state === "attached" || c.state === "ready")) {
        detachCrdt(c);
        c.send("crdt_provider_removed");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveStore]);

  // ── Effect C: sync gate (deps: [effectiveCrdtSynced]) ────
  // When the binding-derived sync flag transitions to true, triggers CRDT attachment.

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || !effectiveCrdtSynced || !effectiveStore) return;
    if (ctrl.state !== "awaiting_sync") return;

    const crepe = ctrl.getCrepe();
    if (!crepe) return;

    ctrl.send("crdt_synced");
    // Now in "attaching" — perform the actual attachment. attachCrdt sends
    // "attach_done" → state is "attached"; markReady is deferred to the
    // first-sync latch (fires on the first ySync content tx, or fallback).
    attachCrdt(ctrl, crepe, effectiveStore, effectiveFragmentKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCrdtSynced]);

  // ── Read-only toggling ─────────────────────────────────

  // A publish pause (doc_publish_pause_start/end) freezes editors read-only
  // mid-edit; `setReadonly(true)` drops contentEditable, which the browser
  // responds to by blurring the element — the caret disappears. ProseMirror keeps
  // the selection in its state across the toggle, so when the pause lifts we
  // re-focus the editor that was focused before the freeze and the caret returns
  // to where it was. Without this the active writer loses their caret on every
  // autonomous/last-editor publish and must click back in.
  const prevReadOnlyRef = useRef(readOnly);
  const hadFocusBeforeReadOnlyRef = useRef(false);
  useEffect(() => {
    const ctrl = controllerRef.current;
    const crepe = ctrl?.getCrepe();
    const wasReadOnly = prevReadOnlyRef.current;
    prevReadOnlyRef.current = readOnly;
    if (!crepe) return;

    if (readOnly && !wasReadOnly) {
      try {
        hadFocusBeforeReadOnlyRef.current = crepe.editor.ctx.get(editorViewCtx).hasFocus();
      } catch {
        // Editor mid-teardown — treat as unfocused.
        hadFocusBeforeReadOnlyRef.current = false;
      }
    }

    crepe.setReadonly(readOnly);

    if (!readOnly && wasReadOnly && ctrl?.isReady() && hadFocusBeforeReadOnlyRef.current) {
      hadFocusBeforeReadOnlyRef.current = false;
      try {
        crepe.editor.ctx.get(editorViewCtx).focus();
      } catch {
        // Editor mid-teardown — nothing to focus.
      }
    }
  }, [readOnly]);

  // ── Render ─────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={{ visibility: ready ? "visible" : "hidden" }}
    />
  );
});
