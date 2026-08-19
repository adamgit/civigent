/**
 * option1-edit-view — the custom Milkdown link-edit PluginView.
 *
 * Replaces the stock Vue `LinkEditTooltip` with a React-rendered floating popup
 * (LinkEditPopup), while preserving stock semantics: it exposes
 * addLink/editLink/removeLink (wired onto `linkTooltipAPI` by install-link-picker),
 * drives `linkTooltipState.mode`, positions via `TooltipProvider` at the selection
 * rect, and applies the link mark through the shared `applyLinkMark` helper.
 */

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Ctx } from "@milkdown/ctx";
import type { PluginView } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { Mark } from "@milkdown/prose/model";
import { editorViewCtx } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import { posToDOMRect } from "@milkdown/prose";
import { TooltipProvider } from "@milkdown/plugin-tooltip";
import { linkSchema } from "@milkdown/preset-commonmark";
import { linkTooltipState } from "@milkdown/components/link-tooltip";

import { applyLinkMark } from "./apply-link-mark";
import { LinkEditPopup } from "./LinkEditPopup";

interface Data {
  from: number;
  to: number;
  mark: Mark | null;
}

const defaultData: Data = { from: -1, to: -1, mark: null };

export class Option1LinkEditView implements PluginView {
  readonly #content: HTMLElement;
  readonly #provider: TooltipProvider;
  readonly #root: Root;
  #data: Data = { ...defaultData };
  /** Bumped on each open so React remounts the popup and resets its input state. */
  #openId = 0;

  constructor(
    readonly ctx: Ctx,
    view: EditorView,
  ) {
    const content = document.createElement("div");
    // `.milkdown-link-edit` reuses the crepe link-tooltip chrome/positioning; the
    // second class marks it as the Option 1 picker variant (picker-only chrome).
    content.className = "milkdown-link-edit milkdown-link-edit-option1";
    this.#content = content;
    this.#root = createRoot(content);

    this.#provider = new TooltipProvider({
      content,
      debounce: 0,
      shouldShow: () => false,
      // Anchor BELOW the selection like a normal autocomplete dropdown. The stock
      // default ('top') put the popup above the selection when short, then flipped
      // below only once tall enough to need a scrollbar — the "jumps above the
      // field" bug. Preferring 'bottom' keeps it below regardless of item count.
      offset: 8,
      floatingUIOptions: { placement: "bottom" },
    });
    this.#provider.onHide = () => {
      requestAnimationFrame(() => {
        view.dom.focus({ preventScroll: true });
      });
    };
    this.#provider.update(view);
  }

  #reset = () => {
    this.#provider.hide();
    this.ctx.update(linkTooltipState.key, (state) => ({
      ...state,
      mode: "preview" as const,
    }));
    this.#data = { ...defaultData };
    // Intentionally do NOT unmount the React content here. hide() sets the tooltip
    // to display:none but leaves floating-ui's autoUpdate ResizeObserver attached
    // to this element; ALSO tearing the children out mid-frame gives that observer
    // a second mutation to reconcile and triggers the benign but noisy
    // "ResizeObserver loop completed with undelivered notifications" browser
    // notification (this is what surfaces on cancel). The stock Vue tooltip keeps
    // its DOM mounted and only hides; we match that. State is still reset on the
    // next open via the changing `key`, and the root is unmounted in destroy().
  };

  #confirm = (href: string) => {
    const view = this.ctx.get(editorViewCtx);
    const { from, to, mark } = this.#data;
    applyLinkMark(this.ctx, view, from, to, mark, href);
    this.#reset();
  };

  #enterEditMode = (initialHref: string, from: number, to: number) => {
    this.ctx.update(linkTooltipState.key, (state) => ({
      ...state,
      mode: "edit" as const,
    }));
    const view = this.ctx.get(editorViewCtx);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
    );
    this.#provider.show(
      { getBoundingClientRect: () => posToDOMRect(view, from, to) },
      view,
    );
    this.#openId += 1;
    this.#root.render(
      createElement(LinkEditPopup, {
        key: this.#openId,
        initialHref,
        onConfirm: this.#confirm,
        onCancel: this.#reset,
      }),
    );
  };

  update = (view: EditorView) => {
    const { selection } = view.state;
    if (!(selection instanceof TextSelection)) return;
    const { from, to } = selection;
    // Only relevant while the popup is open; ignore ordinary selection movement.
    if (this.#data.from === -1) return;
    if (from === this.#data.from && to === this.#data.to) return;
    this.#reset();
  };

  destroy = () => {
    this.#root.unmount();
    this.#provider.destroy();
    this.#content.remove();
  };

  addLink = (from: number, to: number) => {
    this.#data = { from, to, mark: null };
    this.#enterEditMode("", from, to);
  };

  editLink = (mark: Mark, from: number, to: number) => {
    this.#data = { from, to, mark };
    this.#enterEditMode(mark.attrs.href, from, to);
  };

  removeLink = (from: number, to: number) => {
    const view = this.ctx.get(editorViewCtx);
    const tr = view.state.tr;
    tr.removeMark(from, to, linkSchema.type(this.ctx));
    view.dispatch(tr);
    this.#reset();
  };
}
