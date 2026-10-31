import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 公式の導入経路をホストが提供する CLI。 */
export type InstallableAgent = "claude" | "codex";

export interface InstalledAgent {
  agent: InstallableAgent;
  path: string;
}

export interface AgentInstallOutput {
  agent: InstallableAgent;
  stream: "stdout" | "stderr" | "status";
  text: string;
}

/** 出力の購読が完了してから、ユーザーが選択した CLI の導入を開始する。 */
export function installTerminalAgent(agent: InstallableAgent): Promise<InstalledAgent> {
  return invoke("install_terminal_agent", { agent });
}

/** メインウィンドウだけに届く公式インストーラーの進捗を購読する。 */
export function listenAgentInstallOutput(
  callback: (output: AgentInstallOutput) => void,
): Promise<() => void> {
  return getCurrentWindow().listen<AgentInstallOutput>("agent-install-output", (event) =>
    callback(event.payload),
  );
}
