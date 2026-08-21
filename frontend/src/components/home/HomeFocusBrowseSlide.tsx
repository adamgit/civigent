interface HomeFocusBrowseSlideProps {
  sidebarAutoHide: boolean;
  setSidebarAutoHide: (autoHide: boolean) => void;
}

export function HomeFocusBrowseSlide({
  sidebarAutoHide,
  setSidebarAutoHide,
}: HomeFocusBrowseSlideProps) {
  return (
    <>
      <p className="home-slide__body">
        {sidebarAutoHide
          ? "The sidebar is hidden for more room. Hover the left edge of the window to show it."
          : "The sidebar stays open so you can explore. Hide it when you want more room to read."}
      </p>
      <div className="home-slide__links">
        <button
          type="button"
          onClick={() => setSidebarAutoHide(!sidebarAutoHide)}
        >
          {sidebarAutoHide ? "Show sidebar" : "Hide sidebar"} {"\u2192"}
        </button>
      </div>
    </>
  );
}
