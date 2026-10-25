import { useState } from "react";
import { pauseAutonomy, setAutonomyEnabled, useAutonomyStatus } from "../runtime/autonomy/client";
import { requestAutonomySetup } from "./AutonomyPanel";
import "./AutonomyPanel.css";

const COPY = {
  ja: {
    label: "自動作業",
    configure: "任せる範囲を設定",
    description:
      "Onにすると、合意した範囲で自動的に作業します。Offにすると、進行中の作業と次回以降の自動実行を停止します。",
    setup: "初めて使うときは、AIと相談して任せる範囲を決めます。",
    loading: "読み込んでいます…",
    stopping: "作業プロセスの終了を待っています。",
  },
  en: {
    label: "Automatic work",
    configure: "Set work scope",
    description:
      "On starts work within your agreed scope. Off stops current work and future automatic runs.",
    setup: "First, discuss and agree on the scope with your AI.",
    loading: "Loading…",
    stopping: "Waiting for work processes to exit.",
  },
} as const;

/** Bundled settings compose this host component; packs receive no new authority. */
export function AutonomySettings({ language }: { readonly language: "ja" | "en" }) {
  const status = useAutonomyStatus();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[language];
  const enabled = status?.contract?.enabled === true;

  async function toggle() {
    if (!status || pending) return;
    if (!status.contract) {
      requestAutonomySetup();
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (enabled) await pauseAutonomy();
      else await setAutonomyEnabled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="autonomy-settings" aria-label={copy.label}>
      <div className="autonomy-settings-row">
        <span>{copy.label}</span>
        <div className="autonomy-toggle">
          <button
            type="button"
            role="switch"
            aria-label={copy.label}
            aria-checked={enabled}
            disabled={status === null || pending}
            onClick={() => void toggle()}
            className="autonomy-settings-toggle"
          >
            <span className="autonomy-switch-thumb" aria-hidden="true" />
          </button>
          <span aria-hidden="true">{enabled ? "On" : "Off"}</span>
        </div>
      </div>
      <p className="autonomy-muted">{status === null ? copy.loading : copy.description}</p>
      {status?.phase === "stopping" && <p role="status">{copy.stopping}</p>}
      {!status?.contract && <p className="autonomy-muted">{copy.setup}</p>}
      <button type="button" onClick={requestAutonomySetup} className="autonomy-settings-configure">
        {copy.configure}
      </button>
      {(error || status?.error) && (
        <p role="alert" className="autonomy-error">
          {error || status?.error}
        </p>
      )}
    </section>
  );
}
