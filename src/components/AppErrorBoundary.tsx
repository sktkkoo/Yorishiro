import { invoke } from "@tauri-apps/api/core";
import React from "react";
import { snapshotList, snapshotRestore } from "../bindings/tauri-commands";
import { buildRestoreRows } from "../runtime/history/describe-snapshot";
import type { SnapshotEntry } from "../sdk/history";

interface AppErrorBoundaryProps {
  readonly children: React.ReactNode;
}

interface AppErrorBoundaryState {
  readonly error: Error | null;
  readonly errorInfo: React.ErrorInfo | null;
  readonly homeDir: string | null;
  readonly copied: boolean;
  readonly snapshots: ReadonlyArray<SnapshotEntry> | null;
  readonly restoring: boolean;
}

function formatError(error: Error, errorInfo: React.ErrorInfo | null): string {
  const parts = [error.stack || error.message];
  if (errorInfo?.componentStack) parts.push(errorInfo.componentStack);
  return parts.join("\n\n");
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
    errorInfo: null,
    homeDir: null,
    copied: false,
    snapshots: null,
    restoring: false,
  };

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ error, errorInfo });
    void invoke<string>("charminal_home_dir")
      .then((homeDir) => this.setState({ homeDir }))
      .catch(() => this.setState({ homeDir: "" }));
    // 復旧候補として snapshot 一覧を取得（失敗しても空配列で続行）。
    void snapshotList()
      .then((snapshots) => this.setState({ snapshots }))
      .catch(() => this.setState({ snapshots: [] }));
  }

  private async handleRestore(seq: number): Promise<void> {
    // dialog は dynamic import（App.tsx と同パターン）。
    const { ask, message } = await import("@tauri-apps/plugin-dialog");
    const approved = await ask(
      `snapshot #${seq} に ~/.charminal を戻します。よろしいですか？\n` +
        "packs / config.json / init.js を完全置換し、反映のためアプリを再読み込みします（journal は変更しません）。",
      { title: "Charminal — 復元の確認", kind: "warning" },
    );
    if (!approved) return;
    this.setState({ restoring: true });
    try {
      await snapshotRestore({ seq });
      // reload で config/init.js の変更も再適用される（restart-required を満たす）。
      window.location.reload();
    } catch (err) {
      this.setState({ restoring: false });
      void message(`復元に失敗しました: ${err instanceof Error ? err.message : String(err)}`, {
        title: "Charminal",
        kind: "error",
      });
    }
  }

  private renderRestoreSection(): React.ReactNode {
    const { snapshots, restoring } = this.state;
    if (snapshots === null || snapshots.length === 0) return null;
    const rows = buildRestoreRows(snapshots, Date.now());
    return (
      <div className="app-error-boundary-restore">
        <h2>最新変更前の状態に戻す</h2>
        <p>
          壊れた pack が原因なら、<strong>最新の変更前（★推奨）</strong>に戻すと復旧できる
          ことがあります。最新の snapshot は「変更後＝現在の状態」なので、戻しても症状が
          変わらない場合があります。journal は変更しません。config.json / init.js
          を含む復元はアプリを再読み込みします。
        </p>
        <ul>
          {rows.map((row) => (
            <li key={row.seq} className={row.isRecommended ? "is-recommended" : undefined}>
              <span>
                {row.text}
                {row.isLatest ? "（最新 / 現在の状態）" : ""}
                {row.isRecommended ? "  ★推奨" : ""}
              </span>
              <button
                type="button"
                disabled={restoring}
                onClick={() => void this.handleRestore(row.seq)}
              >
                この状態に戻す
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  render(): React.ReactNode {
    const { error, errorInfo, homeDir } = this.state;
    if (error === null) return this.props.children;

    const startupReport = homeDir
      ? `${homeDir}/last-startup.json`
      : "~/.charminal/last-startup.json";
    const packsDir = homeDir ? `${homeDir}/packs/` : "~/.charminal/packs/";
    const safeModeCommand =
      navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.includes("Mac")
        ? "CHARMINAL_SAFE_MODE=1 open /Applications/charminal.app"
        : "CHARMINAL_SAFE_MODE=1 charminal";
    const issueUrl = "https://github.com/sktkkoo/Charminal/issues/new?template=crash_report.yml";

    return (
      <main className="app-error-boundary">
        <section className="app-error-boundary-panel">
          <div className="app-error-boundary-kicker">Charminal crashed</div>
          <h1>Recovery information</h1>
          <p>
            The React runtime stopped while rendering Charminal. A broken user pack can cause this;
            safe mode starts without user packs or init.js. If the crash only happens with user
            packs enabled, try fixing the pack with the Charminal update command or skill instead of
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
              onClick={() => {
                void navigator.clipboard?.writeText(safeModeCommand).then(() => {
                  this.setState({ copied: true });
                });
              }}
            >
              {this.state.copied ? "Copied" : "Copy safe mode command"}
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </section>
      </main>
    );
  }
}
