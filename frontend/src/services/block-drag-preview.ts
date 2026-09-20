import type { GripHoverSlot } from "./block-drag-hover";

const LINE_CLASS = "grip-drop-line";
const LINE_OUTLINE_CLASS = "grip-drop-line--outline";
const NODROP_CLASS = "grip-drop-nodrop";

function placeLine(el: HTMLDivElement, slot: GripHoverSlot): void {
  const rect = slot.rect;
  const y = slot.kind === "outline"
    ? (slot.edge === "before" ? rect.top : rect.bottom)
    : (slot.slot.edge === "before" ? rect.top : rect.bottom);
  el.style.top = `${y}px`;
  el.style.left = `${rect.left}px`;
  el.style.width = `${rect.width}px`;
  el.classList.toggle(LINE_OUTLINE_CLASS, slot.kind === "outline");
}

export class GripDragPreview {
  private line: HTMLDivElement | null = null;
  private nodrop: HTMLDivElement | null = null;

  sync(
    slot: GripHoverSlot | null,
    noDropReason: string | null,
    pointer: { readonly x: number; readonly y: number } | null,
  ): void {
    if (noDropReason) {
      this.clearLine();
      this.showNoDrop(noDropReason, pointer);
      return;
    }
    this.clearNoDrop();
    if (!slot) {
      this.clearLine();
      return;
    }
    this.showLine(slot);
  }

  clear(): void {
    this.clearLine();
    this.clearNoDrop();
  }

  private showLine(slot: GripHoverSlot): void {
    if (!this.line) {
      const el = document.createElement("div");
      el.className = LINE_CLASS;
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
      this.line = el;
    }
    placeLine(this.line, slot);
  }

  private showNoDrop(reason: string, pointer: { readonly x: number; readonly y: number } | null): void {
    if (!this.nodrop) {
      const el = document.createElement("div");
      el.className = NODROP_CLASS;
      document.body.appendChild(el);
      this.nodrop = el;
    }
    this.nodrop.textContent = reason;
    if (pointer) {
      this.nodrop.style.left = `${pointer.x + 12}px`;
      this.nodrop.style.top = `${pointer.y + 16}px`;
    }
  }

  private clearLine(): void {
    this.line?.remove();
    this.line = null;
  }

  private clearNoDrop(): void {
    this.nodrop?.remove();
    this.nodrop = null;
  }
}
