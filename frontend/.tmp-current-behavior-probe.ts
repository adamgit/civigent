import { Window } from "happy-dom";
import * as Y from "yjs";

const win = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Event: win.Event,
  MessageEvent: win.MessageEvent,
  CloseEvent: win.CloseEvent,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

class StubWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  sentMessages: Uint8Array[] = [];
  static lastInstance: StubWebSocket | null = null;

  constructor(readonly url: string) {
    super();
    StubWebSocket.lastInstance = this;
  }

  send(data: ArrayBuffer | Uint8Array): void {
    this.sentMessages.push(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data));
  }

  close(): void {
    this.readyState = StubWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = StubWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  onopen: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
}

globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
win.WebSocket = StubWebSocket as unknown as typeof WebSocket;

const { CrdtProvider } = await import("./src/services/crdt-provider");
const provider = new CrdtProvider(new Y.Doc(), "/test/doc.md");
provider.connect();
StubWebSocket.lastInstance?.open();
const modeTransitionFrame = StubWebSocket.lastInstance?.sentMessages.find((frame) => frame[0] === 0x0c);
const modeTransitionPayload = modeTransitionFrame
  ? JSON.parse(new TextDecoder().decode(modeTransitionFrame.subarray(1)))
  : null;
console.log("FOCUS_TARGET_PROBE", JSON.stringify({
  foundModeTransition: Boolean(modeTransitionFrame),
  requestedMode: modeTransitionPayload?.requestedMode,
  editorFocusTarget: modeTransitionPayload?.editorFocusTarget ?? null,
}));
provider.destroy();

const React = await import("react");
const { render, screen, cleanup } = await import("@testing-library/react");
const { DocumentCanvas } = await import("./src/components/DocumentCanvas");
const { SectionHoverProvider } = await import("./src/contexts/SectionHoverContext");
const { SectionId } = await import("./src/types/live-sections");

const sections = [
  { id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] },
  { id: SectionId.brand("section::beta"), headingPath: ["Beta"] },
];

function renderCanvas(sectionsLoading: boolean): void {
  render(
    React.createElement(
      SectionHoverProvider,
      { activeFragmentKey: null },
      React.createElement(DocumentCanvas, {
        sections,
        sectionsLoading,
        focusedFragmentKey: null,
        proposalMode: false,
        canEditProposalScope: false,
        canEditProposalContent: false,
        proposalScopeMutationInFlight: false,
        selectedProposalSectionKeys: new Set(),
        proposalSectionConflicts: new Map(),
        docPath: "/test/doc.md",
        recentlyChangedByLabel: new Map(),
        injectedByLabel: new Map(),
        dragOverFragmentKey: null,
        isSectionBlocked: () => false,
        publishPaused: false,
        crdtState: "connected",
        transferService: null,
        readyEditors: new Set(),
        getDisplayMarkdown: (section: { headingPath: string[] }) => `${section.headingPath.at(-1)} body`,
        getLiveBinding: () => undefined,
        localEditSink: { recordLocalEdit: () => {} },
        mouseDownPosRef: { current: null },
        onStartEditing: () => {},
        onFocusSection: () => {},
        onSetEditorRef: () => {},
        onEditorReady: () => {},
        onEditorUnready: () => {},
        onCursorExit: () => {},
        onCrossSectionDrop: () => {},
      }),
    ),
  );
}

renderCanvas(false);
const visibleWhenNotLoading = Boolean(screen.queryByText("Alpha body")) && Boolean(screen.queryByText("Beta body"));
cleanup();
renderCanvas(true);
const visibleWhileLoading = Boolean(screen.queryByText("Alpha body")) || Boolean(screen.queryByText("Beta body"));
cleanup();

console.log("CANVAS_LOADING_PROBE", JSON.stringify({
  visibleWhenNotLoading,
  visibleWhileLoading,
}));
