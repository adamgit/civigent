import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminPage } from "../../../pages/AdminPage";
import { jsonResponse } from "../../helpers/fetch-mocks";

const baseConfig = {
  humanInvolvement_preset: "eager" as const,
  humanInvolvement_midpoint_seconds: 7200,
  humanInvolvement_steepness: 1,
};

let fetchMock: ReturnType<typeof vi.fn>;

function defaultFetch(url: unknown, init?: RequestInit) {
  const urlStr = String(url);
  if (urlStr.includes("/api/admin/config") && init?.method === "PUT") {
    const body = JSON.parse(init.body as string);
    return jsonResponse({ ...baseConfig, ...body });
  }
  if (urlStr.includes("/api/admin/config")) {
    return jsonResponse(baseConfig);
  }
  if (urlStr.includes("/api/health")) {
    return jsonResponse({ ok: true });
  }
  if (urlStr.includes("/api/admin/snapshot-health")) {
    return jsonResponse({ status: "ok" });
  }
  if (urlStr.includes("/api/proposals")) {
    return jsonResponse({ proposals: [] });
  }
  if (urlStr.includes("/api/auth/session")) {
    return jsonResponse({ authenticated: true, user: { id: "test-user" } });
  }
  if (urlStr.includes("/api/activity")) {
    return jsonResponse({ items: [] });
  }
  return jsonResponse({});
}

function renderAdmin() {
  return render(
    <MemoryRouter>
      <AdminPage />
    </MemoryRouter>,
  );
}

describe("AdminPage config", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => defaultFetch(url, init));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("loads human-involvement preset from API and shows radio buttons", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText("Human Involvement Preset")).toBeDefined();
    });

    // All four presets should be visible
    expect(screen.getByText("YOLO")).toBeDefined();
    expect(screen.getByText("Aggressive")).toBeDefined();
    expect(screen.getByText("Eager")).toBeDefined();
    expect(screen.getByText("Conservative")).toBeDefined();
  });

  it("shows preset description and thresholds", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText(/Midpoint: 7200s/)).toBeDefined();
      expect(screen.getByText(/Steepness: 1/)).toBeDefined();
    });
  });

  it("changing preset calls updateAdminConfig API", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText("YOLO")).toBeDefined();
    });

    // Click on YOLO preset radio
    const yoloRadio = screen.getByDisplayValue("yolo");
    fireEvent.click(yoloRadio);

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/api/admin/config") && call[1]?.method === "PUT",
      );
      expect(putCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(putCalls[0][1]!.body as string);
      expect(body.humanInvolvement_preset).toBe("yolo");
    });
  });

  it("shows saved message after preset change", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText("YOLO")).toBeDefined();
    });

    fireEvent.click(screen.getByDisplayValue("yolo"));

    await waitFor(() => {
      expect(screen.getByText(/Human involvement preset updated to "yolo"/)).toBeDefined();
    });
  });

  it("local frontend settings saved to localStorage", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.queryByText("Loading operational snapshot...")).toBeNull();
    });

    // Change limit setting
    const limitInput = screen.getByLabelText(/What's New limit/);
    fireEvent.change(limitInput, { target: { value: "50" } });

    // Change days setting
    const daysInput = screen.getByLabelText(/What's New days/);
    fireEvent.change(daysInput, { target: { value: "14" } });

    // Save
    fireEvent.click(screen.getByText("Save local preferences"));

    expect(localStorage.getItem("ks_whats_new_limit")).toBe("50");
    expect(localStorage.getItem("ks_whats_new_days")).toBe("14");
    expect(screen.getByText("Local frontend preferences saved.")).toBeDefined();
  });

  it("local settings persist from localStorage on load", async () => {
    localStorage.setItem("ks_whats_new_limit", "30");
    localStorage.setItem("ks_whats_new_days", "10");

    renderAdmin();
    await waitFor(() => {
      expect(screen.queryByText("Loading operational snapshot...")).toBeNull();
    });

    expect((screen.getByLabelText(/What's New limit/) as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText(/What's New days/) as HTMLInputElement).value).toBe("10");
  });
});
