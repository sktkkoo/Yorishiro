import { invoke } from "@tauri-apps/api/core";
import React from "react";

interface AppErrorBoundaryProps {
  readonly children: React.ReactNode;
}

interface AppErrorBoundaryState {
  readonly error: Error | null;
  readonly errorInfo: React.ErrorInfo | null;
  readonly homeDir: string | null;
  readonly copied: boolean;
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
  };

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ error, errorInfo });
    void invoke<string>("charminal_home_dir")
      .then((homeDir) => this.setState({ homeDir }))
      .catch(() => this.setState({ homeDir: "" }));
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
            packs enabled, try fixing the pack with <code>/charm:update</code> instead of filing an
            issue.
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
