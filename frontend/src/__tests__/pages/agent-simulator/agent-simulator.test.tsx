import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentSimulatorPage } from "../../../pages/AgentSimulatorPage";
import { jsonResponse } from "../../helpers/fetch-mocks";

let fetchMock: ReturnType<typeof vi.fn>;

function renderSimulator() {
  return render(
    <MemoryRouter>
      <AgentSimulatorPage />
    </MemoryRouter>,
  );
}

describe("AgentSimulatorPage", () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);

      // Document tree for picker
      if (urlStr.includes("/api/documents/tree")) {
        return jsonResponse({
          tree: [
            { name: "strategy.md", path: "ops/strategy.md", type: "file" },
            { name: "plan.md", path: "marketing/plan.md", type: "file" },
          ],
        });
      }

      // Agent registration
      if (urlStr.includes("/api/auth/agent/register") && init?.method === "POST") {
        return jsonResponse({
          identity: { id: "agent-sim-1" },
          access_token: "test-bearer-token-abc123def456",
        });
      }

      // Propose
      if (urlStr.includes("/api/proposals/propose") && init?.method === "POST") {
        return jsonResponse({
          proposal_id: "prop-sim-1",
          status: "proposing",
          proposal: {
            id: "prop-sim-1",
            kind: "agent_write",
            writer: { id: "agent-sim-1", type: "agent", displayName: "test-agent" },
            intent: "Agent test edit",
            status: "pending",
            sections: [
              { doc_path: "ops/strategy.md", heading_path: ["Overview"], content: "" },
            ],
            created_at: "2026-01-01T00:00:00.000Z",
          },
          system_analysis: {
            viable_write_targets: [{ doc_path: "ops/strategy.md", heading_path: ["Overview"] }],
          },
        });
      }

      // Begin
      if (urlStr.includes("/begin") && init?.method === "POST") {
        return jsonResponse({ proposal_id: "prop-sim-1", status: "inflight" });
      }

      // Write section
      if (urlStr.includes("/sections") && init?.method === "POST") {
        return jsonResponse({ status: "ok" });
      }

      // Commit
      if (urlStr.includes("/commit") && init?.method === "POST") {
        return jsonResponse({ status: "committed" });
      }

      // Cancel
      if (urlStr.includes("/cancel") && init?.method === "POST") {
        return jsonResponse({ status: "withdrawn" });
      }

      // Document structure for heading picker
      if (urlStr.includes("/api/documents/") && urlStr.includes("/structure")) {
        return jsonResponse({
          structure: [
            { heading: "Overview", level: 2, children: [] },
            { heading: "Goals", level: 2, children: [] },
          ],
        });
      }

      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("step 0: shows register form initially", () => {
    renderSimulator();
    expect(screen.getByText("Register Agent")).toBeDefined();
    expect(screen.getByDisplayValue("test-agent")).toBeDefined();
  });

  it("step 0: register agent calls /api/auth/agent/register", async () => {
    renderSimulator();
    fireEvent.click(screen.getByText("Register Agent"));

    await waitFor(() => {
      const registerCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/api/auth/agent/register") && call[1]?.method === "POST",
      );
      expect(registerCalls.length).toBe(1);
    });
  });

  it("successful registration shows bearer token", async () => {
    renderSimulator();
    fireEvent.click(screen.getByText("Register Agent"));

    await waitFor(() => {
      expect(screen.getByText(/test-bearer-token-abc123/)).toBeDefined();
    });
  });

  it("step 1: after registration, shows create proposal form with doc tree picker", async () => {
    renderSimulator();
    fireEvent.click(screen.getByText("Register Agent"));

    await waitFor(() => {
      expect(screen.getByText("Step 1: Create Proposal")).toBeDefined();
    });

    // Doc tree options loaded
    const docSelect = screen.getByDisplayValue("-- select document --");
    expect(docSelect).toBeDefined();
  });

  it("step 2: begin proposal shows status", async () => {
    renderSimulator();

    // Register
    fireEvent.click(screen.getByText("Register Agent"));
    await waitFor(() => {
      expect(screen.getByText("Step 1: Create Proposal")).toBeDefined();
    });

    // Select document and create proposal
    const docSelect = screen.getByDisplayValue("-- select document --");
    fireEvent.change(docSelect, { target: { value: "ops/strategy.md" } });
    fireEvent.click(screen.getByText("Create Proposal"));

    await waitFor(() => {
      expect(screen.getByText("Step 2: Begin Proposal")).toBeDefined();
    });
  });

  it("step 3: write section shows content textarea", async () => {
    renderSimulator();

    // Register
    fireEvent.click(screen.getByText("Register Agent"));
    await waitFor(() => expect(screen.getByText("Step 1: Create Proposal")).toBeDefined());

    // Propose
    const docSelect = screen.getByDisplayValue("-- select document --");
    fireEvent.change(docSelect, { target: { value: "ops/strategy.md" } });
    fireEvent.click(screen.getByText("Create Proposal"));
    await waitFor(() => expect(screen.getByText("Step 2: Begin Proposal")).toBeDefined());

    // Begin
    fireEvent.click(screen.getByText("Begin"));
    await waitFor(() => expect(screen.getByText("Step 3: Write Section")).toBeDefined());

    expect(screen.getByPlaceholderText("Enter section content...")).toBeDefined();
  });

  it("step 4: commit button calls commit API", async () => {
    renderSimulator();

    // Register → Propose → Begin
    fireEvent.click(screen.getByText("Register Agent"));
    await waitFor(() => expect(screen.getByText("Step 1: Create Proposal")).toBeDefined());

    const docSelect = screen.getByDisplayValue("-- select document --");
    fireEvent.change(docSelect, { target: { value: "ops/strategy.md" } });
    fireEvent.click(screen.getByText("Create Proposal"));
    await waitFor(() => expect(screen.getByText("Step 2: Begin Proposal")).toBeDefined());

    fireEvent.click(screen.getByText("Begin"));
    await waitFor(() => expect(screen.getByText("Step 4: Commit or Cancel")).toBeDefined());

    // Commit
    fireEvent.click(screen.getByText("Commit"));

    await waitFor(() => {
      const commitCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/commit") && call[1]?.method === "POST",
      );
      expect(commitCalls.length).toBeGreaterThan(0);
    });
  });

  it("step 4: cancel button calls cancel API", async () => {
    renderSimulator();

    // Register → Propose → Begin
    fireEvent.click(screen.getByText("Register Agent"));
    await waitFor(() => expect(screen.getByText("Step 1: Create Proposal")).toBeDefined());

    const docSelect = screen.getByDisplayValue("-- select document --");
    fireEvent.change(docSelect, { target: { value: "ops/strategy.md" } });
    fireEvent.click(screen.getByText("Create Proposal"));
    await waitFor(() => expect(screen.getByText("Step 2: Begin Proposal")).toBeDefined());

    fireEvent.click(screen.getByText("Begin"));
    await waitFor(() => expect(screen.getByText("Step 4: Commit or Cancel")).toBeDefined());

    // Cancel
    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => {
      const cancelCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/cancel") && call[1]?.method === "POST",
      );
      expect(cancelCalls.length).toBeGreaterThan(0);
    });
  });

  it("terminal state: committed shows final status", async () => {
    renderSimulator();

    // Full flow: Register → Propose → Begin → Commit
    fireEvent.click(screen.getByText("Register Agent"));
    await waitFor(() => expect(screen.getByText("Step 1: Create Proposal")).toBeDefined());

    fireEvent.change(screen.getByDisplayValue("-- select document --"), { target: { value: "ops/strategy.md" } });
    fireEvent.click(screen.getByText("Create Proposal"));
    await waitFor(() => expect(screen.getByText("Step 2: Begin Proposal")).toBeDefined());

    fireEvent.click(screen.getByText("Begin"));
    await waitFor(() => expect(screen.getByText("Step 4: Commit or Cancel")).toBeDefined());

    fireEvent.click(screen.getByText("Commit"));
    await waitFor(() => {
      expect(screen.getByText("Proposal committed successfully")).toBeDefined();
    });
  });

  it("terminal state: cancelled shows final status", async () => {
    renderSimulator();

    // Full flow: Register → Propose → Begin → Cancel
    fireEvent.click(screen.getByText("Register Agent"));
    await waitFor(() => expect(screen.getByText("Step 1: Create Proposal")).toBeDefined());

    fireEvent.change(screen.getByDisplayValue("-- select document --"), { target: { value: "ops/strategy.md" } });
    fireEvent.click(screen.getByText("Create Proposal"));
    await waitFor(() => expect(screen.getByText("Step 2: Begin Proposal")).toBeDefined());

    fireEvent.click(screen.getByText("Begin"));
    await waitFor(() => expect(screen.getByText("Step 4: Commit or Cancel")).toBeDefined());

    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => {
      expect(screen.getByText("Proposal cancelled")).toBeDefined();
    });
  });

  it("response JSON displayed for register step", async () => {
    renderSimulator();
    fireEvent.click(screen.getByText("Register Agent"));

    await waitFor(() => {
      // ResponseBlock renders with label
      expect(screen.getByText(/Register: \d+ OK/)).toBeDefined();
    });
  });
});
