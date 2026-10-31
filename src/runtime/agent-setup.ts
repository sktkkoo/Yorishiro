import {
  type AgentDescriptor,
  listSupportedAgents,
  type ResolveCommandPathArgs,
  resolveCommandPath,
} from "../bindings/tauri-commands";

export interface DetectedAgent {
  readonly id: string;
  readonly displayName: string;
  readonly binaryName: string;
  readonly path: string | null;
  readonly error?: string;
}

export interface AgentDetectionDeps {
  readonly listSupportedAgents: () => Promise<
    readonly Pick<AgentDescriptor, "id" | "displayName" | "binaryName">[]
  >;
  readonly resolveCommandPath: (args: ResolveCommandPathArgs) => Promise<string | null>;
}

/** 登録済み adapter を正本にし、未検出と検出失敗を分けて返す。 */
export async function detectInstalledAgents(
  deps: Partial<AgentDetectionDeps> = {},
): Promise<readonly DetectedAgent[]> {
  // 一覧の取得失敗は「対応 agent がない」とせず、呼び出し元へ伝える。
  const agents = await (deps.listSupportedAgents ?? listSupportedAgents)();
  const resolvePath = deps.resolveCommandPath ?? resolveCommandPath;
  return Promise.all(
    agents.map(async ({ id, displayName, binaryName }): Promise<DetectedAgent> => {
      try {
        const path = await resolvePath({ command: binaryName });
        return { id, displayName, binaryName, path };
      } catch (error) {
        return {
          id,
          displayName,
          binaryName,
          path: null,
          error:
            error instanceof Error
              ? error.message || error.name
              : String(error) || "Agent detection failed.",
        };
      }
    }),
  );
}

export type AgentStartupResolution =
  | { readonly kind: "ready"; readonly agentId: string; readonly automatic: boolean }
  | { readonly kind: "setup"; readonly reason: "choose" | "missing" | "detection-error" };

export interface AgentStartupOptions {
  readonly agents: readonly DetectedAgent[];
  readonly preferredAgent: string;
  readonly hasSavedChoice: boolean;
}

/** 新しい未選択の記録を優先し、旧 health check の既読を初回選択と混同しない。 */
export function hasSavedAgentChoice({
  hasConfiguredChoice,
  savedChoiceMarker,
  legacyHealthSeen,
}: {
  readonly hasConfiguredChoice: boolean;
  readonly savedChoiceMarker: string | null;
  readonly legacyHealthSeen: boolean;
}): boolean {
  return (
    hasConfiguredChoice ||
    savedChoiceMarker === "1" ||
    (savedChoiceMarker === null && legacyHealthSeen)
  );
}

function isInstalled(agent: DetectedAgent): boolean {
  return agent.error === undefined && agent.path !== null && agent.path.trim() !== "";
}

/** 利用できる CLI があれば導入画面を出さず、既存の選択を優先して起動する。 */
export function resolveAgentStartup({
  agents,
  preferredAgent,
  hasSavedChoice,
}: AgentStartupOptions): AgentStartupResolution {
  const installed = agents.filter(isInstalled);
  const preferred = installed.find((agent) => agent.id === preferredAgent);
  if (preferred) {
    return { kind: "ready", agentId: preferred.id, automatic: !hasSavedChoice };
  }

  // 他の CLI の検出失敗は、利用できる CLI の起動を妨げない。
  // 既存の選択が使えない場合も、切り替えた選択を永続化する。
  const fallback = installed.find((agent) => agent.id === "codex") ?? installed[0];
  if (fallback) {
    return { kind: "ready", agentId: fallback.id, automatic: true };
  }
  return {
    kind: "setup",
    reason: agents.some((agent) => agent.error !== undefined) ? "detection-error" : "missing",
  };
}

export interface AgentSetupGuide {
  readonly url: string;
  readonly command: string;
  readonly termsUrl: string;
}

/** 公式の macOS 導入手順。未登録の agent には推測で導入コマンドを割り当てない。 */
export const AGENT_SETUP_GUIDES: Readonly<Record<string, AgentSetupGuide | undefined>> = {
  codex: {
    url: "https://developers.openai.com/codex/cli",
    command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    termsUrl: "https://openai.com/policies/row-terms-of-use/",
  },
  claude: {
    url: "https://code.claude.com/docs/en/setup",
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    termsUrl: "https://code.claude.com/docs/en/legal-and-compliance",
  },
};
