// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pauseAutonomy, setAutonomyEnabled, useAutonomyStatus } from "../runtime/autonomy/client";
import type { AutonomyStatus } from "../runtime/autonomy/types";
import { requestAutonomySetup } from "./AutonomyPanel";
import { AutonomySettings } from "./AutonomySettings";

vi.mock("../runtime/autonomy/client", () => ({
  useAutonomyStatus: vi.fn(),
  pauseAutonomy: vi.fn(),
  setAutonomyEnabled: vi.fn(),
}));
vi.mock("./AutonomyPanel", () => ({ requestAutonomySetup: vi.fn() }));

const status: AutonomyStatus = {
  contract: {
    goal: "メモを整理する",
    root: "/Users/test/notes",
    allowedOperations: ["write"],
    intervalMinutes: 30,
    maxRunsPerDay: 4,
    enabled: true,
  },
  phase: "thinking",
  nextRunAt: null,
  runs: [],
  error: null,
};

beforeEach(() => {
  vi.mocked(useAutonomyStatus).mockReturnValue(status);
  vi.mocked(pauseAutonomy).mockResolvedValue(undefined);
  vi.mocked(setAutonomyEnabled).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AutonomySettings", () => {
  it("turns Off by stopping current and future work without changing scope", async () => {
    render(<AutonomySettings language="ja" />);
    const toggle = screen.getByRole("switch", { name: "自動作業" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(pauseAutonomy).toHaveBeenCalledOnce());
    expect(setAutonomyEnabled).not.toHaveBeenCalled();
  });

  it("turns On atomically using the saved scope instead of resubmitting a stale contract", async () => {
    if (!status.contract) throw new Error("Test contract missing");
    vi.mocked(useAutonomyStatus).mockReturnValue({
      ...status,
      contract: { ...status.contract, enabled: false },
      phase: "paused",
    });
    render(<AutonomySettings language="en" />);
    fireEvent.click(screen.getByRole("switch", { name: "Automatic work" }));
    await waitFor(() => expect(setAutonomyEnabled).toHaveBeenCalledExactlyOnceWith(true));
    expect(pauseAutonomy).not.toHaveBeenCalled();
    expect(requestAutonomySetup).not.toHaveBeenCalled();
  });

  it("opens consultation when no scope is agreed, without enabling anything", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue({ ...status, contract: null, phase: "idle" });
    render(<AutonomySettings language="ja" />);
    fireEvent.click(screen.getByRole("switch", { name: "自動作業" }));
    expect(requestAutonomySetup).toHaveBeenCalledOnce();
    expect(setAutonomyEnabled).not.toHaveBeenCalled();
    expect(pauseAutonomy).not.toHaveBeenCalled();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the switch state truthful and surfaces a failed stop", async () => {
    vi.mocked(pauseAutonomy).mockRejectedValue(new Error("停止を確認できません"));
    render(<AutonomySettings language="ja" />);
    fireEvent.click(screen.getByRole("switch", { name: "自動作業" }));
    expect((await screen.findByRole("alert")).textContent).toBe("停止を確認できません");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });
});
