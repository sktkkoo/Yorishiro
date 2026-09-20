import { describe, expect, it, vi } from "vitest";
import type { AgentInstallOutput, InstallableAgent, InstalledAgent } from "./agent-install";
import type { DetectedAgent } from "./agent-setup";
import { AgentSetupController } from "./agent-setup-controller";

const agent = (id: string, installed = false): DetectedAgent => ({
  id,
  displayName: id === "claude" ? "Claude Code" : "Codex",
  binaryName: id,
  path: installed ? `/test/bin/${id}` : null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(initial = [agent("claude"), agent("codex")]) {
  const detect = vi.fn(async (): Promise<readonly DetectedAgent[]> => initial);
  const install = vi.fn(async (id: InstallableAgent) => ({ agent: id, path: `/test/bin/${id}` }));
  const stop = vi.fn();
  const listeners: Array<(event: AgentInstallOutput) => void> = [];
  const listen = vi.fn(async (callback: (event: AgentInstallOutput) => void) => {
    listeners.push(callback);
    return stop;
  });
  const persistChoice = vi.fn(async (_id: string) => {});
  const controller = new AgentSetupController({ detect, install, listen });
  const prepare = (hasSavedChoice = false) =>
    controller.prepare({
      preferredAgent: "codex",
      hasSavedChoice,
      persistChoice,
    });
  return { controller, detect, install, listen, stop, listeners, persistChoice, prepare };
}

describe("AgentSetupController", () => {
  it("keeps startup pending without downloading anything until the user chooses or skips", async () => {
    const h = harness();
    const resolved = vi.fn();
    const ready = h.prepare().then(resolved);
    await vi.waitFor(() => expect(h.controller.getSnapshot().visible).toBe(true));
    expect(h.install).not.toHaveBeenCalled();
    expect(h.persistChoice).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
    h.controller.skip();
    await ready;
    expect(resolved).toHaveBeenCalledWith(null);
  });

  it("saves the sole available agent before allowing first startup", async () => {
    const h = harness([agent("claude", true), agent("codex")]);
    expect(await h.prepare()).toBe("claude");
    expect(h.persistChoice).toHaveBeenCalledWith("claude");
    expect(h.controller.wasPresented).toBe(false);
    expect(h.install).not.toHaveBeenCalled();
  });

  it("keeps an existing selection without rewriting it", async () => {
    const h = harness([agent("claude", true), agent("codex", true)]);
    expect(await h.prepare(true)).toBe("codex");
    expect(h.persistChoice).not.toHaveBeenCalled();
  });

  it("starts directly when both agents are already installed without asking for a choice", async () => {
    const h = harness([agent("claude", true), agent("codex", true)]);
    expect(await h.prepare()).toBe("codex");
    expect(h.persistChoice).toHaveBeenCalledWith("codex");
    expect(h.controller.getSnapshot().visible).toBe(false);
    expect(h.controller.wasPresented).toBe(false);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.listen).not.toHaveBeenCalled();
  });

  it("saves an installed fallback when the existing choice is no longer available", async () => {
    const h = harness([agent("claude", true), agent("codex")]);
    expect(await h.prepare(true)).toBe("claude");
    expect(h.persistChoice).toHaveBeenCalledWith("claude");
    expect(h.controller.wasPresented).toBe(false);
    expect(h.install).not.toHaveBeenCalled();
  });

  it("starts a verified agent when another agent cannot be checked", async () => {
    const h = harness([agent("claude", true), { ...agent("codex"), error: "Permission denied" }]);
    expect(await h.prepare()).toBe("claude");
    expect(h.persistChoice).toHaveBeenCalledWith("claude");
    expect(h.controller.wasPresented).toBe(false);
    expect(h.install).not.toHaveBeenCalled();
  });

  it("keeps a failed preference write recoverable instead of starting an unsaved agent", async () => {
    const h = harness([agent("codex", true)]);
    h.persistChoice.mockRejectedValueOnce(new Error("Cannot save settings"));
    const ready = h.prepare();
    await vi.waitFor(() => expect(h.controller.getSnapshot().visible).toBe(true));
    expect(h.controller.getSnapshot().error).toBe("Cannot save settings");
    await h.controller.select("codex");
    expect(await ready).toBe("codex");
  });

  it("can install both independently but prevents duplicate installs and leaving midway", async () => {
    const h = harness();
    const ready = h.prepare();
    await vi.waitFor(() => expect(h.controller.getSnapshot().visible).toBe(true));
    const claude = deferred<InstalledAgent>();
    const codex = deferred<InstalledAgent>();
    h.install.mockImplementation((id) => (id === "claude" ? claude.promise : codex.promise));
    const installClaude = h.controller.install("claude");
    const installCodex = h.controller.install("codex");
    await h.controller.install("claude");
    h.controller.skip();
    await h.controller.select("codex");
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledTimes(2));
    expect(h.controller.getSnapshot().visible).toBe(true);
    expect(h.persistChoice).not.toHaveBeenCalled();
    for (const listener of h.listeners)
      listener({ agent: "claude", stream: "stdout", text: "download\n" });
    expect(h.controller.getSnapshot().installations.claude.output).toBe("download\n");
    expect(h.controller.getSnapshot().installations.codex.output).toBe("");
    codex.resolve({ agent: "codex", path: "/test/bin/codex" });
    await installCodex;
    expect(h.controller.getSnapshot().installations.codex.phase).toBe("complete");
    expect(h.controller.getSnapshot().installations.claude.phase).toBe("installing");
    claude.resolve({ agent: "claude", path: "/test/bin/claude" });
    await installClaude;
    expect(h.stop).toHaveBeenCalledTimes(2);
    h.detect.mockResolvedValue([agent("claude", true), agent("codex", true)]);
    await h.controller.select("codex");
    expect(await ready).toBe("codex");
  });

  it("shows failed installs and supports retry without closing the setup", async () => {
    const h = harness();
    const ready = h.prepare();
    await vi.waitFor(() => expect(h.controller.getSnapshot().visible).toBe(true));
    h.install.mockRejectedValueOnce(new Error("Download failed"));
    await h.controller.install("codex");
    expect(h.controller.getSnapshot().installations.codex).toMatchObject({
      phase: "error",
      error: "Download failed",
    });
    expect(h.controller.getSnapshot().visible).toBe(true);
    await h.controller.install("codex");
    expect(h.controller.getSnapshot().installations.codex.phase).toBe("complete");
    h.controller.skip();
    await ready;
  });

  it("rechecks the executable before selecting and does not launch a removed agent", async () => {
    const h = harness();
    const ready = h.prepare();
    await vi.waitFor(() => expect(h.controller.getSnapshot().visible).toBe(true));
    h.detect.mockResolvedValue([agent("codex", true), agent("claude", true)]);
    await h.controller.refresh();
    h.detect.mockResolvedValue([agent("codex"), agent("claude", true)]);
    await h.controller.select("codex");
    expect(h.persistChoice).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().visible).toBe(true);
    h.controller.skip();
    await ready;
  });

  it("recovers from registry errors and ignores non-allowlisted install requests", async () => {
    const h = harness();
    h.detect.mockRejectedValueOnce(new Error("Registry unavailable"));
    const ready = h.prepare();
    await vi.waitFor(() => expect(h.controller.getSnapshot().reason).toBe("detection-error"));
    await h.controller.install("toString");
    await h.controller.install("opencode");
    expect(h.install).not.toHaveBeenCalled();
    await h.controller.refresh();
    expect(h.controller.getSnapshot().agents).toHaveLength(2);
    expect(h.controller.getSnapshot().error).toBeNull();
    expect(h.controller.getSnapshot().reason).toBe("missing");
    h.detect.mockResolvedValue([agent("claude", true), agent("codex")]);
    await h.controller.refresh();
    expect(h.controller.getSnapshot().reason).toBe("choose");
    h.controller.skip();
    await ready;
  });
});
