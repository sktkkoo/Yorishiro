// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UiContext } from "@yorishiro/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dialogOpenMock, invokeMock, updateCheckMock } = vi.hoisted(() => ({
  dialogOpenMock: vi.fn(),
  invokeMock: vi.fn(),
  updateCheckMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpenMock }));
vi.mock("../../../src/runtime/updater/app-updater", () => ({
  checkForUpdate: updateCheckMock,
}));

import { Panel, type VrmAvatarEntry } from "./ui";

const activeEntry: VrmAvatarEntry = {
  id: "active.vrm",
  fileName: "active.vrm",
  path: "/app/avatars/active.vrm",
  size: 100,
  modifiedMs: 1,
  valid: true,
  invalidReason: null,
  meta: {
    specVersion: "1.0",
    name: "Active",
    version: "1",
    authors: ["Active Author"],
    contactInformation: null,
    references: [],
    license: { name: null, urls: [], thirdPartyLicenses: null },
    allowedUser: { normalized: "notSpecified", raw: null },
    avatarPermission: { normalized: "everyone", raw: "everyone" },
    violentUsage: { normalized: "disallowed", raw: "false" },
    sexualUsage: { normalized: "disallowed", raw: "false" },
    commercialUsage: { normalized: "personalNonProfit", raw: "personalNonProfit" },
    politicalOrReligiousUsage: { normalized: "disallowed", raw: "false" },
    antisocialOrHateUsage: { normalized: "disallowed", raw: "false" },
    redistribution: { normalized: "disallowed", raw: "false" },
    modification: { normalized: "prohibited", raw: "prohibited" },
    creditNotation: { normalized: "required", raw: "required" },
  },
};

const importedEntry: VrmAvatarEntry = {
  ...activeEntry,
  id: "imported.vrm",
  fileName: "imported.vrm",
  path: "/app/avatars/imported.vrm",
  meta: activeEntry.meta === null ? null : { ...activeEntry.meta, name: "Imported" },
};

function settingsContext(setVrm: (path: string | null) => void): UiContext {
  return {
    app: {
      listPersonas: () => [],
      listScenes: () => [],
      listPacks: vi.fn().mockResolvedValue({ packs: [] }),
      getHealthReport: vi.fn().mockResolvedValue({
        generatedAt: "2026-08-15T00:00:00Z",
        summary: "ok",
        selectedAgent: "claude",
        safeMode: false,
        homeDir: "/home/test",
        paths: { config: "", init: "", packs: "", startupReport: "" },
        items: [],
        recommendations: [],
      }),
      getConfig: vi.fn().mockResolvedValue({
        primaryPersona: null,
        activeScene: null,
        terminalAgent: "claude",
        effectiveAgent: "claude",
        agentPinnedByProfile: null,
        ambientAudioMuted: false,
        ambientAudioVolume: 1,
        attentionLightNotifications: true,
        motionIntensity: 1,
        activeAmbientUi: [],
        language: "en",
        resolvedLanguage: "en",
        voiceFrequency: "on",
        tabMetadataBadges: false,
      }),
      setVrm,
    },
    state: { get: () => null },
    history: { list: vi.fn().mockResolvedValue([]), restore: vi.fn() },
    signal: new AbortController().signal,
    emitEvent: vi.fn(),
  } as unknown as UiContext;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

beforeEach(() => {
  updateCheckMock.mockResolvedValue(null);
});

describe("VRM import settings handler", () => {
  it("inspects import without applying, then applies explicitly and cancels back to active", async () => {
    localStorage.setItem("yorishiro:vrm", activeEntry.path);
    const setVrm = vi.fn();
    dialogOpenMock.mockResolvedValue("/downloads/imported.vrm");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "import_vrm") return importedEntry.path;
      if (command === "list_vrm_avatars") {
        const imported = invokeMock.mock.calls.some(([name]) => name === "import_vrm");
        return imported ? [activeEntry, importedEntry] : [activeEntry];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<Panel ctx={settingsContext(setVrm)} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_vrm_avatars"));
    fireEvent.click(screen.getByRole("button", { name: "active.vrm" }));
    await screen.findByRole("option", { name: /active\.vrm/ });
    fireEvent.click(screen.getByRole("option", { name: "Yori" }));
    expect(screen.getByText("LUCAS")).toBeTruthy();
    expect(
      screen.getByText("Standalone redistribution or reuse of the model is prohibited."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel selection" }));

    fireEvent.click(screen.getByRole("button", { name: "Import new…" }));
    const importedOption = await screen.findByRole("option", { name: /imported\.vrm/ });
    expect(importedOption.getAttribute("aria-selected")).toBe("true");
    expect(setVrm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel selection" }));
    expect(screen.getByRole("option", { name: /active\.vrm/ }).getAttribute("aria-selected")).toBe(
      "true",
    );

    const activeOption = screen.getByRole("option", { name: /active\.vrm/ });
    activeOption.focus();
    fireEvent.keyDown(activeOption, { key: "ArrowDown" });
    expect(document.activeElement).toBe(importedOption);
    expect(importedOption.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply avatar" }));
    expect(setVrm).toHaveBeenCalledTimes(1);
    expect(setVrm).toHaveBeenCalledWith(importedEntry.path);
    expect(
      (screen.getByRole("button", { name: "Apply avatar" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("option", { name: /active\.vrm/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel selection" }));
    const listbox = screen.getByRole("listbox", { name: "Choose avatar" });
    expect(
      within(listbox)
        .getByRole("option", { name: /imported\.vrm/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
