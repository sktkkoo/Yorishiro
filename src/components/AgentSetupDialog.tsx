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
    title: "Agent installation",
    choose: "Choose an agent to use.",
    missing: "To use Yorishiro, you need either Codex or Claude Code.",
    "detection-error": "Couldn’t check your installed agents.",
    unsupported: "Use the official guide to install an agent.",
    accountNote:
      "Sign in with your own account after installation. Provider terms and charges apply.",
    details: "Details",
    installed: "Installed",
    unknown: "Couldn’t verify installation",
    installing: "Installing…",
    complete: "Installation finished",
    verifying: "Check again to continue.",
    install: "Install official CLI",
    use: "Use",
    retry: "Retry installation",
    setup: "Official setup",
    terms: "Provider terms",
    manual: "Install command",
    copy: "Copy",
    copied: "Copied",
    copyLabel: "Copy {agent} install command",
    log: "Installation details",
    failed: "Installation failed. Try again.",
    refresh: "Check again",
    checking: "Please wait…",
    skip: "Set up later",
    pending: "Keep Yorishiro open until installation finishes.",
    linkError: "Couldn’t open the link. Try again.",
    copyError: "Couldn’t copy the command. You can select and copy it below.",
  },
  ja: {
    title: "エージェントのインストール",
    choose: "使うエージェントを選んでください。",
    missing: "Yorishiroの利用には Codex か Claude Code のどちらかが必要です。",
    "detection-error": "インストール状況を確認できませんでした。",
    unsupported: "公式ガイドからインストールしてください。",
    accountNote: "導入後、ご自身のアカウントでログインします。料金・利用規約は提供元に準じます。",
    details: "詳細",
    installed: "インストール済み",
    unknown: "インストール状況を確認できません",
    installing: "インストール中…",
    complete: "インストール完了",
    verifying: "再確認して続けてください。",
    install: "公式からインストール",
    use: "使う",
    retry: "インストールを再試行",
    setup: "公式ガイド",
    terms: "利用規約",
    manual: "インストールコマンド",
    copy: "コピー",
    copied: "コピーしました",
    copyLabel: "{agent} のインストールコマンドをコピー",
    log: "ログ",
    failed: "失敗しました。再試行してください。",
    refresh: "再確認",
    checking: "処理中…",
    skip: "あとで設定する",
    pending: "完了までYorishiroを開いたままにしてください。",
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

  useEffect(() => {
    // 外部のターミナルや公式ガイドから戻ったら、導入済みかを調べ直す。
    const onVisible = () => {
      if (document.visibilityState === "visible") onRefresh();
    };
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [onRefresh]);

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
          <h2 className="agent-setup-title" id={titleId} ref={titleRef} tabIndex={-1}>
            {strings.title}
          </h2>
          <p className="agent-setup-description" id={bodyId}>
            {strings[reason]}
          </p>
        </header>

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
                    {isInstalling || isInstalled || isComplete || agentError ? (
                      <p className="agent-setup-status" role="status">
                        {isInstalling
                          ? strings.installing
                          : isInstalled
                            ? strings.installed
                            : isComplete
                              ? strings.complete
                              : strings.unknown}
                      </p>
                    ) : null}
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
                  <details className="agent-setup-details">
                    <summary>{strings.details}</summary>
                    <p className="agent-setup-hint">{strings.accountNote}</p>
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
                    {!isInstalled && canInstall ? (
                      <div className="agent-setup-command">
                        <p>{strings.manual}</p>
                        <div className="agent-setup-command-row">
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
                      </div>
                    ) : null}
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

        {!canInstall ? <p className="agent-setup-notes">{strings.unsupported}</p> : null}

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
