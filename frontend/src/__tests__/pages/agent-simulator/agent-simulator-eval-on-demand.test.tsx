/**
 * AgentSimulatorPage fetches a write target's evaluation/structure data ON DEMAND
 * (spec 07 §Agent simulation; spec 12 agent write policy).
 *
 * The page must NOT pre-fetch a document's section structure for every document;
 * it fetches the selected write-target document's data only AFTER the agent picks
 * it, and renders that data (the heading options). Not a render-only test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { apiClient } from "../../../services/api-client";
import { AgentSimulatorPage } from "../../../pages/AgentSimulatorPage";

const TARGET_DOC = "/ops/strategy.md";

describe("AgentSimulatorPage evaluation-data on demand (spec 12)", () => {
  let getStructure: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(apiClient, "getDocumentsTree").mockResolvedValue({
      tree: [{ type: "file", path: TARGET_DOC }],
    } as never);
    getStructure = vi.spyOn(apiClient, "getDocumentStructure").mockResolvedValue({
      structure: [{ heading: "Overview", level: 1, children: [] }],
    } as never);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const u = String(url);
      const json = u.includes("/register")
        ? { identity: { id: "agent-1" }, access_token: "tok" }
        : { proposals: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(json) } as Response;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("fetches the target document's structure only after it is selected as a write target", async () => {
    render(
      <MemoryRouter>
        <AgentSimulatorPage />
      </MemoryRouter>,
    );

    // Register the agent so the target picker appears.
    fireEvent.click(screen.getByRole("button", { name: /register agent/i }));
    await waitFor(() => expect(screen.getByText(/Agent ID:/)).toBeDefined());

    // On-demand: structure is NOT fetched until a write-target document is chosen.
    expect(getStructure).not.toHaveBeenCalled();

    // Select the target document.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: TARGET_DOC } });

    // Now the target's structure is fetched on demand and its headings render.
    await waitFor(() => expect(getStructure).toHaveBeenCalledWith(TARGET_DOC));
    await waitFor(() => expect(screen.getByRole("option", { name: /Overview/ })).toBeDefined());
  });
});
