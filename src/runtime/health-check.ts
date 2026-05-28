import type { UiAppPackStatusEntry, UiHealthItem, UiHealthReport } from "@charminal/sdk";
import { invoke } from "@tauri-apps/api/core";
import {
  listSupportedAgents,
  mcpServerStatus,
  resolveCommandPath,
} from "../bindings/tauri-commands";
import { resolveEffectiveAgent } from "./sessions";
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
  const [homeDir, safeMode, configText, startupText, agents, mcpStatus, packResult] =
    await Promise.all([
      invoke<string>("charminal_home_dir").catch(() => ""),
      fetchSafeModeFlag().catch(() => false),
      readCharminalConfigText(),
      readLastStartupReport().catch(() => ""),
      listSupportedAgents().catch(() => []),
      mcpServerStatus().catch(() => ({ port: null, error: "Could not read MCP status." })),
      deps.listPacks().catch(() => ({ packs: [] })),
    ]);

  const config = parseConfig(configText);
  // 起動時に実際に使われる agent。defaultProfile が agent profile を指していれば
  // terminalAgent より優先される（App.tsx の bootstrap と同じ解決）。
  const effectiveAgent = resolveEffectiveAgent(config);
  const expectedMcpPort = config.mcpPort ?? 18743;
  const agentPaths = await Promise.all(
    agents.map(async (agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      path: await resolveCommandPath({ command: agent.binaryName }).catch(() => null),
    })),
  );
  const selectedAgent = agentPaths.find((agent) => agent.id === effectiveAgent);
  const selectedAgentPath = selectedAgent?.path ?? null;
  const supportedAgentSummary =
    agentPaths.length === 0
      ? "No registered agents were reported."
      : agentPaths.map((agent) => `${agent.displayName}: ${agent.path ?? "missing"}`).join(" / ");
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
        ? `${effectiveAgent} is selected but was not found on Charminal's PATH.`
        : `${effectiveAgent}: ${selectedAgentPath} (${supportedAgentSummary})`,
      selectedAgentPath === null
        ? "Install the selected agent or switch Agent in Settings."
        : undefined,
    ),
  );

  if (agentPaths.length === 0 || agentPaths.every((agent) => agent.path === null)) {
    items.push(
      healthItem(
        "agent-options",
        "Agent options",
        "warning",
        `No supported agents found on PATH (${agentPaths.map((agent) => agent.displayName).join(" / ")}).`,
        "Install at least one supported agent before using the embedded agent terminal.",
      ),
    );
  }

  items.push(
    healthItem(
      "mcp-port",
      "MCP port",
      mcpStatus.error === null ? "ok" : "warning",
      mcpStatus.error === null
        ? `Charminal MCP is listening on localhost:${mcpStatus.port ?? expectedMcpPort}.`
        : `Charminal MCP did not start on localhost:${expectedMcpPort}: ${mcpStatus.error}`,
      mcpStatus.error === null
        ? undefined
        : "Check whether another process is using the configured MCP port, then restart Charminal.",
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
      failedPacks.length > 0 ? "error" : "ok",
      failedPacks.length > 0
        ? `${packs.length} known, ${failedPacks.length} failed, ${disabledPacks.length} disabled`
        : disabledPacks.length > 0
          ? `${packs.length} known, ${disabledPacks.length} disabled`
          : `${packs.length} known`,
      failedPacks.length > 0 ? "Open Packs above and diagnose the failed entries." : undefined,
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
    selectedAgent: effectiveAgent,
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
