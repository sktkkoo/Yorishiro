import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AGENT_SETUP_GUIDES, type DetectedAgent } from "../runtime/agent-setup";
import "./AgentSetupDialog.css";

export interface AgentSetupDialogProps {
  readonly language: "ja" | "en";
  readonly agents: readonly DetectedAgent[];
  readonly reason: "choose" | "missing" | "detection-error";
  readonly busy: boolean;
  readonly error: string | null;
  readonly installations: Readonly<
    Record<string, { phase: "installing" | "error" | "complete"; output: string; error?: string }>
  >;
  readonly onInstall: (agentId: string) => void;
  readonly onSelect: (agentId: string) => void;
  readonly onRefresh: () => void;
  readonly onSkip: () => void;
}

const STRINGS = {
  en: {
    eyebrow: "FIRST-TIME SETUP",
    title: "Set up your coding agent",
    choose: "Choose an installed agent to get started. You can change it later in Settings.",
    missing:
      "To use Yorishiro’s agent features, install Claude Code or Codex on this computer. You can install either one, or both.",
    "detection-error":
      "We couldn’t check your agents. Check again, or use the setup options below.",
    installNote:
      "Install downloads and runs the provider’s official installer on this computer. An internet connection is required.",
    unsupported: "Follow the official setup instructions to install an agent on this system.",
    accountNote:
      "Use your own provider account. Installation does not sign you in; the agent’s official login flow opens when needed after you start. Provider terms and any account or usage charges apply.",
    installed: "Installed",
    absent: "Not installed",
    unknown: "Couldn’t verify installation",
    installing: "Installing…",
    complete: "Installation finished",
    verifying: "Check again to confirm the agent is ready.",
    install: "Install",
    use: "Use",
    retry: "Retry installation",
    setup: "Official setup",
    terms: "Provider terms",
    manual: "Install with a command",
    copy: "Copy command",
    copied: "Copied",
    copyLabel: "Copy {agent} install command",
    log: "Installation details",
    failed: "Installation failed. You can retry or follow the official setup instructions.",
    refresh: "Check again",
    checking: "Please wait…",
    skip: "Set up later",
    pending:
      "Keep Yorishiro open while installation finishes. You can install the other agent too.",
    linkError: "Couldn’t open the link. Try again.",
    copyError: "Couldn’t copy the command. You can select and copy it below.",
  },
  ja: {
    eyebrow: "初回セットアップ",
    title: "エージェントを準備する",
    choose: "インストール済みのエージェントで始められます。あとから設定で変更できます。",
    missing:
      "ヨリシロのエージェント機能を使うには、Claude Code または Codex のインストールが必要です。片方でも、両方でも導入できます。",
    "detection-error":
      "エージェントを確認できませんでした。再確認するか、以下の案内からセットアップしてください。",
    installNote:
      "「インストール」を押すと、提供元の公式インストーラーをダウンロードし、このコンピューターで実行します。インターネット接続が必要です。",
    unsupported: "この環境では、公式セットアップの手順に従ってインストールしてください。",
    accountNote:
      "ご自身の提供元アカウントを使用します。インストールとログインは別です。開始後、必要に応じて公式のログイン手順に進みます。提供元の利用規約と、アカウント・利用に応じた料金が適用されます。",
    installed: "インストール済み",
    absent: "未インストール",
    unknown: "インストール状況を確認できません",
    installing: "インストール中…",
    complete: "インストールが完了しました",
    verifying: "再確認して、エージェントが使えることを確認してください。",
    install: "インストール",
    use: "使う",
    retry: "インストールを再試行",
    setup: "公式セットアップ",
    terms: "提供元の利用規約",
    manual: "コマンドでインストール",
    copy: "コマンドをコピー",
    copied: "コピーしました",
    copyLabel: "{agent} のインストールコマンドをコピー",
    log: "インストールの詳細",
    failed: "インストールに失敗しました。再試行するか、公式セットアップの手順をご確認ください。",
    refresh: "再確認",
    checking: "処理中…",
    skip: "あとで設定する",
    pending: "完了までヨリシロを開いたままにしてください。もう一方も続けてインストールできます。",
    linkError: "リンクを開けませんでした。もう一度お試しください。",
    copyError: "コピーできませんでした。表示されたコマンドを選択してコピーしてください。",
  },
} as const;

const BUILT_IN_AGENTS = [
  { id: "codex", displayName: "Codex", binaryName: "codex", path: null },
  { id: "claude", displayName: "Claude Code", binaryName: "claude", path: null },
] as const;

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const closedDetails = element.closest("details:not([open])");
    return !closedDetails || element === closedDetails.querySelector("summary");
  });
}

export function AgentSetupDialog({
  language,
  agents,
  reason,
  busy,
  error,
  installations,
  onInstall,
  onSelect,
  onRefresh,
  onSkip,
}: AgentSetupDialogProps): React.ReactPortal | null {
  const strings = STRINGS[language];
  const titleId = useId();
  const bodyId = useId();
  const noteId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedAgent, setCopiedAgent] = useState<string | null>(null);
  const canInstall =
    typeof navigator !== "undefined" &&
    /Mac|Linux/i.test(navigator.platform) &&
    !/Android|iPhone|iPad/i.test(navigator.userAgent);
  const installing = Object.values(installations).some((entry) => entry.phase === "installing");
  const canLeave = !busy && !installing;
  const visibleAgents = [
    ...BUILT_IN_AGENTS.map(
      (fallback) => agents.find((agent) => agent.id === fallback.id) ?? fallback,
    ),
    ...agents.filter(
      (agent) =>
        agent.id !== "codex" && agent.id !== "claude" && agent.path?.trim() && !agent.error,
    ),
  ];

  useEffect(() => {
    const previousFocus = document.activeElement;
    titleRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  async function openOfficialUrl(url: string): Promise<void> {
    setActionError(null);
    try {
      await openUrl(url);
    } catch {
      setActionError(strings.linkError);
    }
  }

  async function copyCommand(agentId: string, command: string): Promise<void> {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(command);
      setCopiedAgent(agentId);
    } catch {
      setActionError(strings.copyError);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="agent-setup-overlay">
      <div
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="agent-setup-panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (canLeave) onSkip();
          }
          if (event.key !== "Tab" || !dialogRef.current) return;
          const elements = focusableElements(dialogRef.current);
          const first = elements[0];
          const last = elements[elements.length - 1];
          const active = document.activeElement;
          if (elements.length === 0) {
            event.preventDefault();
            titleRef.current?.focus();
          } else if (
            event.shiftKey &&
            (active === first || !elements.includes(active as HTMLElement))
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (active === last || !elements.includes(active as HTMLElement))
          ) {
            event.preventDefault();
            first?.focus();
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="agent-setup-header">
          <p className="agent-setup-eyebrow">{strings.eyebrow}</p>
          <h2 className="agent-setup-title" id={titleId} ref={titleRef} tabIndex={-1}>
            {strings.title}
          </h2>
          <p className="agent-setup-description" id={bodyId}>
            {strings[reason]}
          </p>
        </header>

        <div className="agent-setup-notes" id={noteId}>
          <p>{canInstall ? strings.installNote : strings.unsupported}</p>
          <p>{strings.accountNote}</p>
        </div>

        <div className="agent-setup-agents">
          {visibleAgents.map((agent) => {
            const guide =
              agent.id === "codex" || agent.id === "claude" ? AGENT_SETUP_GUIDES[agent.id] : null;
            const installation = installations[agent.id];
            const isInstalling = installation?.phase === "installing";
            const isComplete = installation?.phase === "complete";
            const agentError = "error" in agent ? agent.error : undefined;
            const isInstalled = Boolean(agent.path?.trim()) && !agentError;
            return (
              <section
                aria-label={agent.displayName}
                className="agent-setup-card"
                data-installed={isInstalled}
                key={agent.id}
              >
                <div className="agent-setup-card-header">
                  <div>
                    <h3>{agent.displayName}</h3>
                    <p className="agent-setup-status" role="status">
                      {isInstalling
                        ? strings.installing
                        : isInstalled
                          ? strings.installed
                          : isComplete
                            ? strings.complete
                            : agentError
                              ? strings.unknown
                              : strings.absent}
                    </p>
                  </div>
                  {isInstalled ? (
                    <button
                      className="agent-setup-button agent-setup-button-primary"
                      disabled={busy || installing}
                      onClick={() => onSelect(agent.id)}
                      type="button"
                    >
                      {language === "ja"
                        ? `${agent.displayName} を${strings.use}`
                        : `${strings.use} ${agent.displayName}`}
                    </button>
                  ) : guide && canInstall ? (
                    <button
                      aria-describedby={noteId}
                      aria-label={
                        isInstalling
                          ? `${agent.displayName}: ${strings.installing}`
                          : isComplete
                            ? `${agent.displayName}: ${strings.refresh}`
                            : `${agent.displayName}: ${installation?.phase === "error" ? strings.retry : strings.install}`
                      }
                      className="agent-setup-button agent-setup-button-primary"
                      disabled={busy || isInstalling}
                      onClick={() => (isComplete ? onRefresh() : onInstall(agent.id))}
                      type="button"
                    >
                      {isInstalling
                        ? strings.installing
                        : isComplete
                          ? strings.refresh
                          : installation?.phase === "error"
                            ? strings.retry
                            : strings.install}
                    </button>
                  ) : null}
                </div>

                {guide ? (
                  <div className="agent-setup-links">
                    {[
                      { label: strings.setup, url: guide.url },
                      { label: strings.terms, url: guide.termsUrl },
                    ].map((link) => (
                      <a
                        href={link.url}
                        key={link.url}
                        onClick={(event) => {
                          event.preventDefault();
                          void openOfficialUrl(link.url);
                        }}
                      >
                        {link.label} <span aria-hidden="true">↗</span>
                      </a>
                    ))}
                  </div>
                ) : null}

                {!isInstalled && guide && canInstall ? (
                  <details className="agent-setup-details">
                    <summary>{strings.manual}</summary>
                    <div className="agent-setup-command">
                      <code>{guide.command}</code>
                      <button
                        aria-label={strings.copyLabel.replace("{agent}", agent.displayName)}
                        className="agent-setup-button agent-setup-button-secondary"
                        onClick={() => void copyCommand(agent.id, guide.command)}
                        type="button"
                      >
                        {copiedAgent === agent.id ? strings.copied : strings.copy}
                      </button>
                    </div>
                  </details>
                ) : null}

                {isComplete && !isInstalled ? (
                  <p className="agent-setup-hint">{strings.verifying}</p>
                ) : null}
                {agentError ? (
                  <p className="agent-setup-error" role="alert">
                    {agentError}
                  </p>
                ) : null}
                {installation?.phase === "error" ? (
                  <p className="agent-setup-error" role="alert">
                    {strings.failed}
                    {installation.error ? ` ${installation.error}` : ""}
                  </p>
                ) : null}
                {installation?.output ? (
                  <details className="agent-setup-details agent-setup-log">
                    <summary>{strings.log}</summary>
                    <pre
                      aria-label={`${agent.displayName}: ${strings.log}`}
                      aria-live="off"
                      role="log"
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable output needs keyboard scrolling.
                      tabIndex={0}
                    >
                      {installation.output}
                    </pre>
                  </details>
                ) : null}
              </section>
            );
          })}
        </div>

        {error || actionError ? (
          <p className="agent-setup-error" role="alert">
            {error || actionError}
          </p>
        ) : null}
        <p aria-live="polite" className="agent-setup-pending">
          {installing ? strings.pending : ""}
        </p>
        <footer className="agent-setup-footer">
          <button
            className="agent-setup-button agent-setup-button-secondary"
            disabled={busy || installing}
            onClick={onRefresh}
            type="button"
          >
            {busy ? strings.checking : strings.refresh}
          </button>
          <button
            className="agent-setup-button agent-setup-button-quiet"
            disabled={!canLeave}
            onClick={onSkip}
            type="button"
          >
            {strings.skip}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
