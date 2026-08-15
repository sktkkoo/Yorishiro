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
  meta:
    activeEntry.meta === null
      ? null
      : {
          ...activeEntry.meta,
          specVersion: "1.1",
          name: "Imported",
          license: {
            ...activeEntry.meta.license,
            urls: ["https://example.test/permission"],
          },
        },
};

function settingsContext(
  setVrm: (path: string | null) => void,
  openExternal = vi.fn().mockResolvedValue(undefined),
): UiContext {
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
      openExternal,
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
    const openExternal = vi.fn().mockResolvedValue(undefined);
    dialogOpenMock.mockResolvedValue("/downloads/imported.vrm");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "import_vrm") return importedEntry.path;
      if (command === "list_vrm_avatars") {
        const imported = invokeMock.mock.calls.some(([name]) => name === "import_vrm");
        return imported ? [activeEntry, importedEntry] : [activeEntry];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<Panel ctx={settingsContext(setVrm, openExternal)} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_vrm_avatars"));
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: "Change avatar" });
    await screen.findByRole("option", { name: /active\.vrm/ });
    const yoriOption = screen.getByRole("option", { name: "Yori" });
    expect(yoriOption.querySelector("img")?.getAttribute("src")).toBe("/models/Yori-thumbnail.png");
    expect(screen.getByText("Creator")).toBeTruthy();
    expect(screen.getAllByText("Active Author").length).toBeGreaterThan(0);
    const activeRestrictions = screen.getByRole("group", { name: "Content restrictions" });
    expect(activeRestrictions.querySelectorAll(":scope > div")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: "Yori" }));
    expect(screen.getAllByText("Default avatar").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("group", { name: "Content restrictions" }).querySelectorAll(":scope > div"),
    ).toHaveLength(2);
    expect(screen.getAllByText("LUCAS").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Standalone redistribution or reuse of the model is prohibited.").length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Change avatar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add from file…" }));
    const importedOption = await screen.findByRole("option", { name: /imported\.vrm/ });
    expect(importedOption.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Added to the list.")).toBeTruthy();
    expect(screen.getAllByText("1.1").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("More details"));
    fireEvent.click(screen.getByRole("button", { name: "https://example.test/permission" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.test/permission");
    expect(setVrm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(screen.getByRole("option", { name: /active\.vrm/ }).getAttribute("aria-selected")).toBe(
      "true",
    );

    const activeOption = screen.getByRole("option", { name: /active\.vrm/ });
    const importedAfterReopen = screen.getByRole("option", { name: /imported\.vrm/ });
    activeOption.focus();
    fireEvent.keyDown(activeOption, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(importedAfterReopen));
    expect(importedAfterReopen.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Switch to this avatar" }));
    expect(setVrm).toHaveBeenCalledTimes(1);
    expect(setVrm).toHaveBeenCalledWith(importedEntry.path);
    expect(screen.queryByRole("dialog", { name: "Change avatar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(
      (screen.getByRole("button", { name: "Switch to this avatar" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("option", { name: /active\.vrm/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("listbox", { name: "Choose avatar" })).toBeNull();
  });

  it("removes a selected imported avatar only after confirmation", async () => {
    localStorage.setItem("yorishiro:vrm", activeEntry.path);
    const setVrm = vi.fn();
    let removed = false;
    invokeMock.mockImplementation(async (command: string, args?: { id?: string }) => {
      if (command === "list_vrm_avatars")
        return removed ? [activeEntry] : [activeEntry, importedEntry];
      if (command === "remove_vrm_avatar") {
        expect(args?.id).toBe(importedEntry.id);
        removed = true;
        return true;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<Panel ctx={settingsContext(setVrm)} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_vrm_avatars"));
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.click(await screen.findByRole("option", { name: /imported\.vrm/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from list…" }));

    const confirmation = screen.getByRole("alertdialog", { name: "Remove from the list?" });
    expect(confirmation.textContent).toContain(
      "The original VRM file you selected will not be deleted",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove from list" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("remove_vrm_avatar", { id: importedEntry.id }),
    );
    await waitFor(() => expect(screen.queryByRole("option", { name: /imported\.vrm/ })).toBeNull());
    expect(screen.getAllByText("Removed Imported from the list.").length).toBeGreaterThan(0);
    expect(setVrm).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Remove from list…" })).toBeNull();
  });

  it("reports and clears a stale active path that is no longer in the catalog", async () => {
    localStorage.setItem("yorishiro:vrm", "/app/avatars/moved-away.vrm");
    const setVrm = vi.fn();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_vrm_avatars") return [];
      throw new Error(`unexpected command: ${command}`);
    });

    render(<Panel ctx={settingsContext(setVrm)} />);
    await waitFor(() => expect(setVrm).toHaveBeenCalledWith(null));
    expect(
      screen.getByText("moved-away.vrm was not found and was removed from the list."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(
      (await screen.findByRole("option", { name: /Yori/ })).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("renders large catalogs in progressive groups of twenty", async () => {
    const entries = Array.from(
      { length: 25 },
      (_, index): VrmAvatarEntry => ({
        ...activeEntry,
        id: `avatar-${String(index).padStart(2, "0")}.vrm`,
        fileName: `avatar-${String(index).padStart(2, "0")}.vrm`,
        path: `/app/avatars/avatar-${String(index).padStart(2, "0")}.vrm`,
        meta:
          activeEntry.meta === null
            ? null
            : { ...activeEntry.meta, name: `Avatar ${String(index).padStart(2, "0")}` },
      }),
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_vrm_avatars") return entries;
      throw new Error(`unexpected command: ${command}`);
    });
    localStorage.setItem("yorishiro:vrm", entries[0]?.path ?? "");

    render(<Panel ctx={settingsContext(vi.fn())} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_vrm_avatars"));
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    const list = screen.getByRole("listbox", { name: "Choose avatar" });
    expect(within(list).getAllByRole("option")).toHaveLength(20);
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 650 },
    });
    fireEvent.scroll(list);
    expect(within(list).getAllByRole("option")).toHaveLength(26);
  });
});
