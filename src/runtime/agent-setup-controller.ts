import { installTerminalAgent, listenAgentInstallOutput } from "./agent-install";
import { type DetectedAgent, detectInstalledAgents, resolveAgentStartup } from "./agent-setup";

export interface AgentInstallationState {
  readonly phase: "installing" | "error" | "complete";
  readonly output: string;
  readonly error?: string;
}

export interface AgentSetupSnapshot {
  readonly visible: boolean;
  readonly agents: readonly DetectedAgent[];
  readonly reason: "choose" | "missing" | "detection-error";
  readonly busy: boolean;
  readonly error: string | null;
  readonly installations: Readonly<Record<string, AgentInstallationState>>;
}

interface PrepareAgentSetupOptions {
  readonly preferredAgent: string;
  readonly hasSavedChoice: boolean;
  readonly persistChoice: (agent: string) => Promise<void>;
}

interface AgentSetupControllerDeps {
  readonly detect: typeof detectInstalledAgents;
  readonly install: typeof installTerminalAgent;
  readonly listen: typeof listenAgentInstallOutput;
}

const INITIAL_STATE: AgentSetupSnapshot = {
  visible: false,
  agents: [],
  reason: "missing",
  busy: false,
  error: null,
  installations: {},
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 初回 health check の導入待ちを管理する。React の再 mount / HMR で失われない
 * host-owned store として保持し、選択が完了するまで agent の PTY 起動を待たせる。
 * インストールは install() に対するユーザー操作からだけ開始する。
 */
export class AgentSetupController {
  private state: AgentSetupSnapshot = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly deps: AgentSetupControllerDeps;
  private pending: {
    readonly options: PrepareAgentSetupOptions;
    readonly resolve: (agent: string | null) => void;
  } | null = null;
  private refreshSequence = 0;
  private presented = false;

  constructor(deps: Partial<AgentSetupControllerDeps> = {}) {
    this.deps = {
      detect: detectInstalledAgents,
      install: installTerminalAgent,
      listen: listenAgentInstallOutput,
      ...deps,
    };
  }

  readonly getSnapshot = (): AgentSetupSnapshot => this.state;

  get wasPresented(): boolean {
    return this.presented;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<AgentSetupSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private get installing(): boolean {
    return Object.values(this.state.installations).some((item) => item.phase === "installing");
  }

  async prepare(options: PrepareAgentSetupOptions): Promise<string | null> {
    if (this.pending) throw new Error("Agent setup is already open.");
    let reason: AgentSetupSnapshot["reason"] = "detection-error";
    let error: string | null = null;
    let agents: readonly DetectedAgent[] = [];
    try {
      agents = await this.deps.detect();
      const decision = resolveAgentStartup({ ...options, agents });
      if (decision.kind === "ready") {
        // 初回の自動選択も永続化する。保存済みの設定には触れない。
        if (decision.automatic) await options.persistChoice(decision.agentId);
        return decision.agentId;
      }
      reason = decision.reason;
    } catch (failure) {
      error = messageOf(failure);
    }
    return new Promise<string | null>((resolve) => {
      this.pending = { options, resolve };
      this.presented = true;
      this.update({ visible: true, agents, reason, busy: false, error, installations: {} });
    });
  }

  readonly refresh = async (): Promise<void> => {
    if (!this.pending || this.state.busy || this.installing) return;
    const sequence = ++this.refreshSequence;
    this.update({ busy: true, error: null });
    try {
      const agents = await this.deps.detect();
      if (sequence !== this.refreshSequence || !this.pending) return;
      this.update({
        agents,
        reason: agents.some((agent) => agent.error)
          ? "detection-error"
          : agents.some((agent) => agent.path)
            ? "choose"
            : "missing",
      });
    } catch (error) {
      this.update({ error: messageOf(error), reason: "detection-error" });
    } finally {
      if (sequence === this.refreshSequence) this.update({ busy: false });
    }
  };

  readonly select = async (agentId: string): Promise<void> => {
    const pending = this.pending;
    if (!pending || this.state.busy || this.installing) return;
    this.update({ busy: true, error: null });
    try {
      // 表示後にアンインストールされた場合も、未導入のまま起動させない。
      const agents = await this.deps.detect();
      this.update({ agents });
      const selected = agents.find((agent) => agent.id === agentId);
      if (!selected?.path || selected.error) {
        throw new Error("The selected agent could not be found. Install it, then check again.");
      }
      await pending.options.persistChoice(agentId);
      this.pending = null;
      this.update({ visible: false, busy: false });
      pending.resolve(agentId);
    } catch (error) {
      this.update({ busy: false, error: messageOf(error) });
    }
  };

  readonly skip = (): void => {
    const pending = this.pending;
    if (!pending || this.state.busy || this.installing) return;
    this.pending = null;
    this.update({ visible: false });
    pending.resolve(null);
  };

  readonly install = async (agentId: string): Promise<void> => {
    if (
      !this.pending ||
      this.state.busy ||
      (agentId !== "codex" && agentId !== "claude") ||
      this.state.installations[agentId]?.phase === "installing" ||
      this.state.agents.some((agent) => agent.id === agentId && agent.path !== null && !agent.error)
    )
      return;

    const setInstallation = (value: AgentInstallationState): void => {
      this.update({ installations: { ...this.state.installations, [agentId]: value } });
    };
    setInstallation({ phase: "installing", output: "" });
    let unlisten: (() => void) | undefined;
    try {
      // listener を先に確立し、導入開始直後の出力も取りこぼさない。
      unlisten = await this.deps.listen((event) => {
        if (event.agent !== agentId) return;
        const current = this.state.installations[agentId];
        if (current?.phase !== "installing") return;
        setInstallation({ ...current, output: `${current.output}${event.text}`.slice(-16_384) });
      });
      const result = await this.deps.install(agentId);
      const existing = this.state.agents.find((agent) => agent.id === agentId);
      const detected: DetectedAgent = {
        id: agentId,
        displayName: existing?.displayName ?? (agentId === "claude" ? "Claude Code" : "Codex"),
        binaryName: existing?.binaryName ?? agentId,
        path: result.path,
      };
      this.update({
        agents: [...this.state.agents.filter((agent) => agent.id !== agentId), detected],
      });
      setInstallation({
        phase: "complete",
        output: this.state.installations[agentId]?.output ?? "",
      });
    } catch (error) {
      setInstallation({
        phase: "error",
        output: this.state.installations[agentId]?.output ?? "",
        error: messageOf(error),
      });
    } finally {
      unlisten?.();
    }
  };
}
