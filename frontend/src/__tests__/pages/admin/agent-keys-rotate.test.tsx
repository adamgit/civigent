import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentKeysPage } from "../../../pages/AgentKeysPage";
import { installFetchMock, jsonResponse, type InstalledFetchMock, type FetchCall } from "../../helpers/fetch-mocks";

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentKeysPage />
    </MemoryRouter>,
  );
}

describe("AgentKeysPage — rotate secret", () => {
  let fetchMock: InstalledFetchMock;
  let confirmMock: ReturnType<typeof vi.fn>;
  let originalConfirm: typeof window.confirm | undefined;

  beforeEach(() => {
    fetchMock = installFetchMock(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/admin/agents" && method === "GET") {
        return jsonResponse({
          agents: [{ agent_id: "agent-a", display_name: "Agent A" }],
          errors: [],
        });
      }
      if (url === "/api/admin/config" && method === "GET") {
        return jsonResponse({ agent_auth_policy: "verify" });
      }
      if (url === "/api/admin/agents/agent-a/rotate-secret" && method === "POST") {
        return jsonResponse({
          agent_id: "agent-a",
          display_name: "Agent A",
          secret: "sk_rotated_newsecret_abc",
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    fetchMock?.restore();
    if (originalConfirm === undefined) {
      delete (window as unknown as { confirm?: typeof window.confirm }).confirm;
    } else {
      window.confirm = originalConfirm;
    }
    vi.restoreAllMocks();
  });

  function installConfirm(returnValue: boolean) {
    originalConfirm = (window as unknown as { confirm?: typeof window.confirm }).confirm;
    confirmMock = vi.fn().mockReturnValue(returnValue);
    (window as unknown as { confirm: typeof window.confirm }).confirm =
      confirmMock as unknown as typeof window.confirm;
  }

  function rotateApiCall(calls: FetchCall[]): FetchCall | undefined {
    return calls.find(
      (c) =>
        String(c.input) === "/api/admin/agents/agent-a/rotate-secret" &&
        (c.init?.method ?? "GET").toUpperCase() === "POST",
    );
  }

  it("confirmation cancel does NOT call the API", async () => {
    installConfirm(false);
    renderPage();
    const btn = await waitFor(() =>
      screen.getByRole("button", { name: /rotate secret/i }),
    );
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(confirmMock).toHaveBeenCalled();
    expect(rotateApiCall(fetchMock.calls)).toBeUndefined();
    expect(screen.queryByText(/secret rotated for/i)).toBeNull();
  });

  it("confirmation accept calls the API and surfaces the new secret in the rotated banner", async () => {
    installConfirm(true);
    renderPage();
    const btn = await waitFor(() =>
      screen.getByRole("button", { name: /rotate secret/i }),
    );
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(rotateApiCall(fetchMock.calls)).toBeDefined();
    });
    expect(await screen.findByText(/secret rotated for: agent-a/i)).toBeDefined();
    expect(screen.getByText(/sk_rotated_newsecret_abc/)).toBeDefined();
    expect(screen.queryByText(/new agent created/i)).toBeNull();
  });

  it("rotate API error surfaces in the error region", async () => {
    installConfirm(true);
    fetchMock.restore();
    fetchMock = installFetchMock(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/admin/agents" && method === "GET") {
        return jsonResponse({
          agents: [{ agent_id: "agent-a", display_name: "Agent A" }],
          errors: [],
        });
      }
      if (url === "/api/admin/config" && method === "GET") {
        return jsonResponse({ agent_auth_policy: "verify" });
      }
      if (url === "/api/admin/agents/agent-a/rotate-secret" && method === "POST") {
        return jsonResponse({ message: "boom: rotation failed" }, { status: 500 });
      }
      return jsonResponse({});
    });

    renderPage();
    const btn = await waitFor(() =>
      screen.getByRole("button", { name: /rotate secret/i }),
    );
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(await screen.findByText(/boom: rotation failed/i)).toBeDefined();
    expect(screen.queryByText(/secret rotated for/i)).toBeNull();
  });
});
