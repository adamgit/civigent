import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactElement } from "react";

export type RenderWithRouterOptions = Omit<RenderOptions, "wrapper"> & {
  initialPath?: string;
  routePath?: string;
};

export function renderWithRouter(
  ui: ReactElement,
  options: RenderWithRouterOptions = {},
) {
  const { initialPath = "/", routePath = "*", ...renderOptions } = options;

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path={routePath} element={ui} />
      </Routes>
    </MemoryRouter>,
    renderOptions,
  );
}
