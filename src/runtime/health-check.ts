import type { UiAppPackStatusEntry, UiHealthItem, UiHealthReport } from "@charminal/sdk";
import { invoke } from "@tauri-apps/api/core";
import { resolveCommandPath } from "../bindings/tauri-commands";
import {
  fetchSafeModeFlag,
  readCharminalConfigText,
  readLastStartupReport,
} from "./user-pack-loader/charminal-io";
import { parseConfig } from "./user-pack-loader/config";

export interface CollectHealthReportDeps {
  readonly listPacks: () => Promise<{ readonly packs: readonly UiAppPackStatusEntry[] }>;
}

function healthItem(
  id: string,
  label: string,
  status: UiHealthItem["status"],
  detail: string,
  action?: string,
): UiHealthItem {
  return { id, label, status, detail, action };
}

function summarize(items: readonly UiHealthItem[]): UiHealthReport["summary"] {
  if (items.some((item) => item.status === "error")) return "error";
  if (items.some((item) => item.status === "warning")) return "warning";
  return "ok";
}

function parseLoadReport(text: string): { failed: number; total: number } | null {
  if (text.trim() === "") return null;
  try {
    const parsed = JSON.parse(text) as {
      readonly loadResults?: readonly { readonly status?: string }[];
    };
    const results = Array.isArray(parsed.loadResults) ? parsed.loadResults : [];
    return {
      failed: results.filter((item) => item.status === "failed").length,
      total: results.length,
    };
  } catch {
    return null;
  }
}

export async function collectHealthReport(deps: CollectHealthReportDeps): Promise<UiHealthReport> {
  const [homeDir, safeMode, configText, startupText, claudePath, codexPath, packResult] =
    await Promise.all([
      invoke<string>("charminal_home_dir").catch(() => ""),
      fetchSafeModeFlag().catch(() => false),
      readCharminalConfigText(),
      readLastStartupReport().catch(() => ""),
      resolveCommandPath({ command: "claude" }).catch(() => null),
      resolveCommandPath({ command: "codex" }).catch(() => null),
      deps.listPacks().catch(() => ({ packs: [] })),
    ]);

  const config = parseConfig(configText);
  const selectedAgentPath = config.terminalAgent === "claude" ? claudePath : codexPath;
  const packs = packResult.packs;
  const failedPacks = packs.filter((pack) => pack.status === "failed");
  const disabledPacks = packs.filter((pack) => pack.status === "disabled");
  const startup = parseLoadReport(startupText);
  const items: UiHealthItem[] = [];

  items.push(
    healthItem(
      "home",
      "Charminal home",
      homeDir === "" ? "error" : "ok",
      homeDir === "" ? "Could not resolve ~/.charminal." : homeDir,
      homeDir === "" ? "Restart Charminal and check filesystem permissions." : undefined,
    ),
  );

  items.push(
    healthItem(
      "agent",
      "Terminal agent",
      selectedAgentPath === null ? "error" : "ok",
      selectedAgentPath === null
        ? `${config.terminalAgent} is selected but was not found on Charminal's PATH.`
        : `${config.terminalAgent}: ${selectedAgentPath}`,
      selectedAgentPath === null
        ? "Install the selected agent or switch Agent in Settings."
        : undefined,
    ),
  );

  items.push(
    healthItem(
      "agent-options",
      "Agent options",
      claudePath === null && codexPath === null ? "warning" : "ok",
      `Claude Code: ${claudePath ?? "not found"} / Codex: ${codexPath ?? "not found"}`,
      claudePath === null && codexPath === null
        ? "Install Claude Code or Codex before using the embedded agent terminal."
        : undefined,
    ),
  );

  items.push(
    healthItem(
      "safe-mode",
      "Safe mode",
      safeMode ? "warning" : "ok",
      safeMode ? "User packs and init.js are skipped for recovery." : "Off",
      safeMode ? "Unset CHARMINAL_SAFE_MODE and restart after disabling broken packs." : undefined,
    ),
  );

  items.push(
    healthItem(
      "packs",
      "Packs",
      failedPacks.length > 0 ? "error" : disabledPacks.length > 0 ? "warning" : "ok",
      `${packs.length} known, ${failedPacks.length} failed, ${disabledPacks.length} disabled`,
      failedPacks.length > 0 ? "Open Packs below and diagnose the failed entries." : undefined,
    ),
  );

  items.push(
    healthItem(
      "startup-report",
      "Startup report",
      startup === null ? "warning" : startup.failed > 0 ? "error" : "ok",
      startup === null
        ? "No readable last-startup.json yet."
        : `${startup.total} user pack load result(s), ${startup.failed} failed`,
      startup === null
        ? "Start Charminal once outside safe mode to generate the report."
        : undefined,
    ),
  );

  const recommendations = items
    .filter((item) => item.action !== undefined)
    .map((item) => item.action as string);

  return {
    generatedAt: new Date().toISOString(),
    summary: summarize(items),
    selectedAgent: config.terminalAgent,
    safeMode,
    homeDir,
    paths: {
      config: homeDir === "" ? "config.json" : `${homeDir}/config.json`,
      init: homeDir === "" ? "init.js" : `${homeDir}/init.js`,
      packs: homeDir === "" ? "packs/" : `${homeDir}/packs/`,
      startupReport: homeDir === "" ? "last-startup.json" : `${homeDir}/last-startup.json`,
    },
    items,
    recommendations,
  };
}
