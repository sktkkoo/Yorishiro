import { describe, expect, it, vi } from "vitest";
import { getStrings, resolvePackRepairPrompt } from "../../../src/i18n/strings";
import { KNOWN_AGENT_IDS } from "../../../src/runtime/user-pack-loader/config";
import {
  applyConfigUpdate,
  configPrimaryPersonaForSelection,
  creditsSections,
  EXPERIMENTAL_AGENT_IDS,
  filterPersonaOptionsForLanguage,
  localizedAgentOptions,
  type NewSessionChangeKind,
  packWorkbenchKey,
  resolveCloseTarget,
  resolveNewSessionConfirm,
  resolvePersonaSelectValue,
  SETTINGS_PACK_ID,
  selectWorkbenchPack,
  summarizePackDiagnosis,
  TERMINAL_AGENT_OPTIONS,
} from "./ui";

describe("resolveCloseTarget", () => {
  it("returns the saved previous id when valid", () => {
    expect(resolveCloseTarget({ saved: "attention-aura", availableIds: ["attention-aura"] })).toBe(
      "attention-aura",
    );
  });

  it("returns null when no previous id is saved", () => {
    expect(resolveCloseTarget({ saved: null, availableIds: ["attention-aura"] })).toBeNull();
  });

  it("returns null when saved id refers to settings itself (init.js mistake)", () => {
    expect(
      resolveCloseTarget({ saved: SETTINGS_PACK_ID, availableIds: [SETTINGS_PACK_ID] }),
    ).toBeNull();
  });

  it("returns null when saved id is no longer in available ids (disabled / hot reload removal)", () => {
    expect(resolveCloseTarget({ saved: "old-pack", availableIds: ["attention-aura"] })).toBeNull();
  });
});

describe("applyConfigUpdate", () => {
  it("commits the next value when write succeeds", async () => {
    const setLocal = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    const emitEvent = vi.fn();
    const dispatched: unknown[] = [];
    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    });
    try {
      await applyConfigUpdate({
        next: "scene-a",
        prev: null,
        setLocal,
        write,
        emitEvent,
        field: "activeScene",
      });
      expect(setLocal).toHaveBeenCalledWith("scene-a");
      expect(setLocal).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith("scene-a");
      expect(emitEvent).not.toHaveBeenCalled();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toBeInstanceOf(CustomEvent);
      expect((dispatched[0] as CustomEvent).type).toBe("yorishiro-settings:config-changed");
      expect((dispatched[0] as CustomEvent).detail).toEqual({ field: "activeScene" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rolls back and emits write-failed when write rejects", async () => {
    const setLocal = vi.fn();
    const write = vi.fn().mockRejectedValue(new Error("disk full"));
    const emitEvent = vi.fn();
    await applyConfigUpdate({
      next: "scene-a",
      prev: "scene-quiet",
      setLocal,
      write,
      emitEvent,
      field: "activeScene",
    });
    expect(setLocal).toHaveBeenNthCalledWith(1, "scene-a");
    expect(setLocal).toHaveBeenNthCalledWith(2, "scene-quiet");
    expect(emitEvent).toHaveBeenCalledWith("yorishiro-settings:write-failed", {
      field: "activeScene",
      reason: "disk full",
    });
  });
});

describe("localized CLAI persona options", () => {
  const personas = [
    { id: "clai-en", name: "CLAI", origin: "bundled" as const },
    { id: "clai-ja", name: "CLAI", origin: "bundled" as const },
    { id: "my-persona", name: "Mine", origin: "user" as const },
  ];

  it("shows only English CLAI for English UI language", () => {
    expect(filterPersonaOptionsForLanguage(personas, "en").map((p) => p.id)).toEqual([
      "clai-en",
      "my-persona",
    ]);
  });

  it("shows only Japanese CLAI for Japanese UI language", () => {
    expect(filterPersonaOptionsForLanguage(personas, "ja").map((p) => p.id)).toEqual([
      "clai-ja",
      "my-persona",
    ]);
  });

  it("shows the localized CLAI selection for unset config", () => {
    expect(resolvePersonaSelectValue(null, "ja")).toBe("clai-ja");
    expect(resolvePersonaSelectValue("clai-en", "ja")).toBe("clai-ja");
  });

  it("stores localized CLAI selection as null so language changes keep following", () => {
    expect(configPrimaryPersonaForSelection("clai-en")).toBeNull();
    expect(configPrimaryPersonaForSelection("clai-ja")).toBeNull();
    expect(configPrimaryPersonaForSelection("my-persona")).toBe("my-persona");
  });
});

describe("terminal agent options", () => {
  it("shows only release-supported agents in settings", () => {
    expect(TERMINAL_AGENT_OPTIONS).toEqual([
      { value: "claude", label: "Claude Code" },
      { value: "codex", label: "Codex" },
    ]);
  });

  it("uses only agent ids accepted by config validation", () => {
    // 設定画面は config が受け付ける agent の subset。内部 adapter があっても
    // 初回リリースでは user-facing option に出さない agent がある。
    for (const option of TERMINAL_AGENT_OPTIONS) {
      expect(KNOWN_AGENT_IDS.has(option.value)).toBe(true);
    }
    const optionIds = new Set<string>(TERMINAL_AGENT_OPTIONS.map((option) => option.value));
    expect(optionIds.has("opencode")).toBe(false);
  });

  it("marks Codex as the only experimental settings option", () => {
    expect(EXPERIMENTAL_AGENT_IDS.has("claude")).toBe(false);
    expect(EXPERIMENTAL_AGENT_IDS.has("codex")).toBe(true);
    // 全 experimental id は実在の agent option である（typo 検知）。
    const optionIds = new Set<string>(TERMINAL_AGENT_OPTIONS.map((option) => option.value));
    for (const id of EXPERIMENTAL_AGENT_IDS) {
      expect(optionIds.has(id)).toBe(true);
    }
  });

  it("appends a localized suffix only to experimental agent labels", () => {
    const options = localizedAgentOptions("experimental");
    const byId = new Map<string, string>(options.map((o) => [o.value, o.label]));
    expect(byId.get("claude")).toBe("Claude Code");
    expect(byId.get("codex")).toBe("Codex（experimental）");
    expect(byId.has("opencode")).toBe(false);
  });
});

describe("resolveNewSessionConfirm", () => {
  const ja = getStrings("ja");
  const en = getStrings("en");
  const kinds: readonly NewSessionChangeKind[] = ["persona", "agent", "voice"];

  it("persona: light switch wording — the conversation starts fresh, no goodbye ceremony", () => {
    // お別れの儀式は新規ペルソナ作成時の goodbye switch（MCP 経路）だけ。
    // 既存ペルソナ間の切替は軽い確認に留める。
    const r = resolveNewSessionConfirm(ja, { kind: "persona", nextLabel: "Mint" });
    expect(r.message).toBe("Mint に切り替えます。会話は新しく始まります。");
    expect(r.confirmLabel).toBe("切り替える");
    expect(r.message).not.toContain("お別れ");

    const rEn = resolveNewSessionConfirm(en, { kind: "persona", nextLabel: "Mint" });
    expect(rEn.message).toBe("Switch to Mint. The conversation starts fresh.");
    expect(rEn.confirmLabel).toBe("Switch");
  });

  it("agent: pause wording with both agent names and a resume hint", () => {
    const r = resolveNewSessionConfirm(ja, {
      kind: "agent",
      currentLabel: "Claude Code",
      nextLabel: "Codex",
    });
    expect(r.message).toContain("Codex に切り替えて再起動");
    expect(r.message).toContain("Claude Code との会話はいったん区切り");
    expect(r.message).toContain("続きから再開");
    expect(r.confirmLabel).toBe("切り替える");
  });

  it("voice: restart wording that promises the conversation continues", () => {
    const r = resolveNewSessionConfirm(ja, { kind: "voice" });
    expect(r.message).toBe("反映のためにセッションを再起動します。会話は続きから再開します。");
    expect(r.confirmLabel).toBe("再起動する");
    expect(resolveNewSessionConfirm(en, { kind: "voice" }).confirmLabel).toBe("Restart");
  });

  it("leaves no unreplaced placeholders and avoids the generic continue button", () => {
    for (const strings of [ja, en]) {
      const resolved = kinds.map((kind) =>
        resolveNewSessionConfirm(strings, { kind, currentLabel: "A", nextLabel: "B" }),
      );
      for (const r of resolved) {
        expect(r.message).not.toMatch(/[{}]/);
        expect(r.confirmLabel.length).toBeGreaterThan(0);
        // ボタンは操作の動詞。generic な「続ける / Continue」には縮退しない。
        expect(["続ける", "Continue"]).not.toContain(r.confirmLabel);
      }
    }
  });
});

describe("settings presence target", () => {
  it("declares shell presence for settings UI placement", async () => {
    const settingsPack = (await import("./ui")).default;

    expect(settingsPack.layout.presence).toEqual({ target: "shell" });
  });
});

describe("credits sections", () => {
  it("includes the mandatory pixiv attribution line (license obligation)", () => {
    const allLines = creditsSections().flatMap((s) => s.lines.map((l) => l.text));
    expect(allLines).toContain("Character animation credits to pixiv Inc.'s VRoid Project");
  });

  it("credits the bundled character model and key built-with stack", () => {
    const byLabel = new Map(creditsSections().map((s) => [s.label, s]));

    const character = byLabel.get("Character");
    expect(character?.lines.map((l) => l.text)).toContain("CLAI — character model by LUCAS");

    const builtWith = byLabel.get("Built with");
    const builtWithNames = builtWith?.lines.map((l) => l.text) ?? [];
    expect(builtWithNames).toContain("Tauri");
    expect(builtWithNames).toContain("@pixiv/three-vrm");
    // built-with の各行は license note を伴う。
    expect(builtWith?.lines.every((l) => Boolean(l.note))).toBe(true);
  });

  it("every section has a non-empty label and at least one line", () => {
    for (const section of creditsSections()) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.lines.length).toBeGreaterThan(0);
      expect(section.lines.every((l) => l.text.length > 0)).toBe(true);
    }
  });
});

describe("Pack Workbench helpers", () => {
  const packs = [
    {
      id: "ok-scene",
      kind: "scene",
      origin: "user" as const,
      status: "loaded" as const,
      isActive: false,
    },
    {
      id: "broken-effect",
      kind: "effect",
      origin: "user" as const,
      status: "failed" as const,
      isActive: false,
    },
  ];

  it("builds stable row keys from kind and id", () => {
    expect(packWorkbenchKey(packs[0])).toBe("scene:ok-scene");
  });

  it("keeps the previous selection when it still exists", () => {
    expect(selectWorkbenchPack("scene:ok-scene", packs)).toBe("scene:ok-scene");
  });

  it("selects the first problem pack when previous selection is gone", () => {
    expect(selectWorkbenchPack("scene:missing", packs)).toBe("effect:broken-effect");
  });

  it("summarizes diagnosis errors for the detail panel", () => {
    expect(
      summarizePackDiagnosis({
        id: "broken-effect",
        ok: false,
        diagnoses: [],
        diagnostics: [
          {
            severity: "error",
            code: "pack-load-failed",
            message: "module has no default export",
          },
        ],
        recommendations: [],
      }),
    ).toEqual({
      state: "error",
      title: "Pack needs attention",
      detail: "module has no default export",
    });
  });

  it("summarizes active healthy packs", () => {
    expect(
      summarizePackDiagnosis({
        id: "ok-scene",
        ok: true,
        diagnoses: [
          {
            id: "ok-scene",
            kind: "scene",
            origin: "user",
            status: "loaded",
            isActive: true,
          },
        ],
        diagnostics: [
          {
            severity: "info",
            code: "pack-loaded",
            message: "scene pack 'ok-scene' is loaded and active",
          },
        ],
        recommendations: [],
      }),
    ).toEqual({
      state: "healthy",
      title: "Pack looks healthy",
      detail: "The pack is loaded and active.",
    });
  });

  it("formats a host-owned repair prompt for pack handoff", () => {
    expect(
      resolvePackRepairPrompt({
        id: "broken-effect",
        kind: "effect",
        action: "repair",
        language: "en",
      }),
    ).toBe(
      '/yori:update Diagnose and repair broken-effect (effect). Start with pack_diagnose({ id: "broken-effect" }).',
    );
    expect(
      resolvePackRepairPrompt({
        id: "my-scene",
        kind: "scene",
        action: "improve",
        language: "en",
      }),
    ).toBe(
      '/yori:update Diagnose and improve my-scene (scene). Start with pack_diagnose({ id: "my-scene" }).',
    );
    expect(
      resolvePackRepairPrompt({
        id: "broken-persona",
        kind: "persona",
        action: "repair",
        language: "ja",
      }),
    ).toBe(
      '/yori:update broken-persona (persona) を診断して、修正してください。まず pack_diagnose({ id: "broken-persona" }) で状態を確認してください。',
    );
    expect(
      resolvePackRepairPrompt({
        id: "ok-scene",
        kind: "scene",
        action: "improve",
        language: "ja",
      }),
    ).toBe(
      '/yori:update ok-scene (scene) を診断して、改善してください。まず pack_diagnose({ id: "ok-scene" }) で状態を確認してください。',
    );
  });

  it("rejects unsafe pack ids in repair prompt", () => {
    expect(() =>
      resolvePackRepairPrompt({ id: "../etc", action: "repair", language: "en" }),
    ).toThrow("invalid pack id");
    expect(() =>
      resolvePackRepairPrompt({ id: "foo;rm -rf", action: "repair", language: "en" }),
    ).toThrow("invalid pack id");
    expect(() =>
      resolvePackRepairPrompt({ id: "ok", kind: "a;b", action: "repair", language: "en" }),
    ).toThrow("invalid pack kind");
  });
});
