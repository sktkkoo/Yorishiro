import { invoke } from "@tauri-apps/api/core";
import React from "react";
import { snapshotList, snapshotRestore } from "../bindings/tauri-commands";
import { changeStrings, getStrings, restoreConfirmStrings, type UiStrings } from "../i18n/strings";
import { buildRestoreRows } from "../runtime/history/describe-snapshot";
import { getBrowserLocales, resolveLanguage } from "../runtime/language/language";
import type { SnapshotEntry } from "../sdk/history";
import { RestoreConfirmDialog } from "./RestoreConfirmDialog";

interface AppErrorBoundaryProps {
  readonly children: React.ReactNode;
}

interface AppErrorBoundaryState {
  readonly error: Error | null;
  readonly errorInfo: React.ErrorInfo | null;
  readonly homeDir: string | null;
  readonly copyStatus: "idle" | "copying" | "copied" | "failed";
  readonly snapshots: ReadonlyArray<SnapshotEntry> | null;
  readonly restoreTarget: RestoreDialogTarget | null;
}

interface RestoreDialogTarget {
  readonly seq: number;
  readonly changeText: string;
  readonly timeText: string;
}

function formatError(error: Error, errorInfo: React.ErrorInfo | null): string {
  const parts = [error.stack || error.message];
  if (errorInfo?.componentStack) parts.push(errorInfo.componentStack);
  return parts.join("\n\n");
}

function crashRestoreStrings(): { readonly locale: string; readonly strings: UiStrings } {
  const locale = resolveLanguage("auto", getBrowserLocales());
  return { locale, strings: getStrings(locale) };
}

const COPY_STRINGS = {
  en: {
    copy: "Copy safe mode command",
    copying: "Copying…",
    copied: "Copied",
    failed: "Couldn’t copy. Select and copy the safe mode command above.",
  },
  ja: {
    copy: "セーフモードのコマンドをコピー",
    copying: "コピー中…",
    copied: "コピーしました",
    failed: "コピーできませんでした。上のコマンドを選択してコピーしてください。",
  },
} as const;

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
    errorInfo: null,
    homeDir: null,
    copyStatus: "idle",
    snapshots: null,
    restoreTarget: null,
  };

  private copyInFlight = false;

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ error, errorInfo });
    void invoke<string>("yorishiro_home_dir")
      .then((homeDir) => this.setState({ homeDir }))
      .catch(() => this.setState({ homeDir: "" }));
    // 復旧候補として snapshot 一覧を取得（失敗しても空配列で続行）。
    void snapshotList()
      .then((snapshots) => this.setState({ snapshots }))
      .catch(() => this.setState({ snapshots: [] }));
  }

  private async copySafeModeCommand(command: string): Promise<void> {
    if (this.copyInFlight) return;
    this.copyInFlight = true;
    this.setState({ copyStatus: "copying" });
    try {
      await navigator.clipboard.writeText(command);
      this.setState({ copyStatus: "copied" });
    } catch {
      this.setState({ copyStatus: "failed" });
    } finally {
      this.copyInFlight = false;
    }
  }

  private renderRestoreSection(): React.ReactNode {
    const { restoreTarget, snapshots } = this.state;
    if (snapshots === null || snapshots.length === 0) return null;
    const { locale, strings } = crashRestoreStrings();
    const rows = buildRestoreRows(snapshots, Date.now(), changeStrings(strings), locale);
    const recommendedText = strings.restoreCrashRecommendedText.replace(
      "{tag}",
      strings.restoreRecommendedTag,
    );
    return (
      <div className="app-error-boundary-restore">
        <h2>{strings.restoreCrashTitle}</h2>
        <p>
          {strings.restoreCrashIntroPrefix}
          <strong>{recommendedText}</strong>
          {strings.restoreCrashIntroSuffix}
        </p>
        <ul>
          {rows.map((row) => (
            <li key={row.seq} className={row.isRecommended ? "is-recommended" : undefined}>
              <span className="app-error-boundary-restore-row-text">
                <span
                  className={
                    row.startupStatus === "error"
                      ? "app-error-boundary-restore-row-change is-error"
                      : "app-error-boundary-restore-row-change"
                  }
                >
                  {row.changeText}
                </span>
                <span className="app-error-boundary-restore-row-time">· {row.timeText}</span>
                {row.isLatest ? (
                  <span className="app-error-boundary-restore-row-time">
                    {strings.restoreLatestTag}
                  </span>
                ) : null}
                {row.isRecommended ? (
                  <span className="app-error-boundary-restore-recommended">
                    {strings.restoreRecommendedTag}
                  </span>
                ) : null}
                {row.changedItems.length > 0 ? (
                  <span className="app-error-boundary-restore-row-detail">
                    {row.changedItems.join(", ")}
                  </span>
                ) : null}
              </span>
              {/* 最新（現在の状態）は戻しても no-op なのでボタンを出さない。 */}
              {row.isLatest ? null : (
                <button
                  type="button"
                  disabled={restoreTarget !== null}
                  onClick={() =>
                    this.setState({
                      restoreTarget: {
                        seq: row.seq,
                        changeText: row.changeText,
                        timeText: row.timeText,
                      },
                    })
                  }
                >
                  {strings.restoreButton}
                </button>
              )}
            </li>
          ))}
        </ul>
        {restoreTarget ? (
          <RestoreConfirmDialog
            seq={restoreTarget.seq}
            changeText={restoreTarget.changeText}
            timeText={restoreTarget.timeText}
            surface="crash"
            strings={restoreConfirmStrings(strings)}
            onClose={() => this.setState({ restoreTarget: null })}
            onConfirm={() => snapshotRestore({ seq: restoreTarget.seq })}
          />
        ) : null}
      </div>
    );
  }

  render(): React.ReactNode {
    const { error, errorInfo, homeDir, copyStatus } = this.state;
    if (error === null) return this.props.children;
    const copy = COPY_STRINGS[resolveLanguage("auto", getBrowserLocales())];

    const startupReport = homeDir
      ? `${homeDir}/last-startup.json`
      : "~/.yorishiro/last-startup.json";
    const packsDir = homeDir ? `${homeDir}/packs/` : "~/.yorishiro/packs/";
    const safeModeCommand =
      navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.includes("Mac")
        ? "YORISHIRO_SAFE_MODE=1 open /Applications/Yorishiro.app"
        : "YORISHIRO_SAFE_MODE=1 yorishiro";
    const issueUrl = "https://github.com/sktkkoo/Yorishiro/issues/new?template=crash_report.yml";

    return (
      <main className="app-error-boundary">
        <section className="app-error-boundary-panel">
          <div className="app-error-boundary-kicker">Yorishiro crashed</div>
          <h1>Recovery information</h1>
          <p>
            The React runtime stopped while rendering Yorishiro. A broken user pack can cause this;
            safe mode starts without user packs or init.js. If the crash only happens with user
            packs enabled, try fixing the pack with the Yorishiro update command or skill instead of
            filing an issue.
          </p>
          <div className="app-error-boundary-grid">
            <div>Safe mode</div>
            <code>{safeModeCommand}</code>
            <div>User packs</div>
            <code>{packsDir}</code>
            <div>Startup report</div>
            <code>{startupReport}</code>
          </div>
          <details>
            <summary>Error details</summary>
            <pre>{formatError(error, errorInfo)}</pre>
          </details>
          {this.renderRestoreSection()}
          <div className="app-error-boundary-actions">
            <a href={issueUrl} target="_blank" rel="noreferrer">
              Report crash
            </a>
            <button
              type="button"
              disabled={copyStatus === "copying"}
              onClick={() => void this.copySafeModeCommand(safeModeCommand)}
            >
              {copyStatus === "copying"
                ? copy.copying
                : copyStatus === "copied"
                  ? copy.copied
                  : copy.copy}
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
          {copyStatus === "failed" ? <p role="alert">{copy.failed}</p> : null}
        </section>
      </main>
    );
  }
}
