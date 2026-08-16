interface HomeFocusBrowseSlideProps {
  sidebarAutoHide: boolean;
  setSidebarAutoHide: (autoHide: boolean) => void;
}

export function HomeFocusBrowseSlide({
  sidebarAutoHide,
  setSidebarAutoHide,
}: HomeFocusBrowseSlideProps) {
  return (
    <div className="home-slide">
      <div className="home-slide__kicker">Workspace layout</div>
      <h2 className="home-slide__title">Focus or Browse</h2>
      <div className="home-focus-browse">
        <button
          type="button"
          onClick={() => setSidebarAutoHide(true)}
          aria-pressed={sidebarAutoHide}
          className={`home-focus-browse__btn${sidebarAutoHide ? " home-focus-browse__btn--focus" : ""}`}
        >
          <div className="home-focus-browse__name">Focus mode</div>
          <p>
            Hide the sidebar for more room to read and write. Hover the left edge of the window when you need the document tree again.
          </p>
        </button>
        <button
          type="button"
          onClick={() => setSidebarAutoHide(false)}
          aria-pressed={!sidebarAutoHide}
          className={`home-focus-browse__btn${sidebarAutoHide ? "" : " home-focus-browse__btn--browse"}`}
        >
          <div className="home-focus-browse__name">Browse mode</div>
          <p>
            Keep the sidebar open so you can jump between documents. Use this when you are exploring or moving around often.
          </p>
        </button>
      </div>
    </div>
  );
}
