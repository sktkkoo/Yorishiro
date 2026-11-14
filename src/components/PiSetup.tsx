import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  loginActive,
  type PiCommandPreset,
  type PiSetupCode,
  setupReady,
  usePiSetup,
} from "../runtime/continuity/pi-setup";
import "./PiSetup.css";

export interface PiSetupProps {
  readonly open?: boolean;
  readonly panelId?: string;
  readonly onClose?: () => void;
  readonly onAttentionChange?: (attention: boolean) => void;
  readonly cwd: string | null;
  readonly language: "ja" | "en";
  readonly onConfigured?: () => void;
  readonly onReadinessChange?: (ready: boolean) => void;
}
const COPY = {
  ja: {
    title: "設定",
    close: "設定を閉じる",
    workspaceLabel: "アクセスを許可するフォルダ",
    loading: "接続設定を確認しています…",
    description: "OpenAIにログインし、選択中の作業フォルダで許可する操作を確認してください。",
    signIn: "OpenAIにログイン",
    reconnect: "ログインし直す",
    authPresent: "ログイン情報があります。",
    authMissing: "自律実行用のログインが必要です。",
    waiting: "ブラウザのOpenAI画面でログインし、接続を許可してください。",
    cancelling: "ログインを取り消しています…",
    cancel: "ログインを取り消す",
    cancelled: "ログインを取り消しました。",
    model: "使用するモデル",
    permissions: "選択中の作業フォルダで許可する操作",
    read: "ファイルを読む",
    write: "ファイルを作成・変更する",
    info: "作業フォルダの概要を確認する",
    validate: "JSONファイルを検証する",
    gitStatus: "Gitの状態を読む",
    gitDiff: "Gitの差分を読む",
    projectCheck: "プロジェクトの検証を実行する",
    projectTest: "プロジェクトのテストを実行する",
    projectBuild: "プロジェクトのビルドを実行する",
    projectCommands:
      "検証・テスト・ビルドは、選択中のプロジェクトのスクリプトやコードを実行します。ファイル変更の許可がOffでも、生成物の作成・変更や、あなたのアカウントで可能な他の操作を伴います。許可する実行を個別に選択してください。",
    save: "設定を保存して自律実行に使用",
    saving: "保存しています…",
    scope:
      "自律実行に許可する操作を保存します。ファイルを直接読み書きする操作は選択中の作業フォルダ内に制限されます。実行のOn／Offは上部のスイッチで変更できます。",
    workspace: "先に作業フォルダを選択してください。",
    legacy:
      "以前の開発用設定があります。操作権限を確認して保存すると、アプリ同梱の実行環境へ切り替えます。",
    runtime: "自律実行の実行環境を読み込めません。アプリを更新または再インストールしてください。",
    retry: "接続状態を再確認",
    checking: "接続状態を確認しています…",
    retryHint: "ログインや実行環境の状態を更新します。設定の変更は保存されません。",
    failed: "ログインまたは設定に失敗しました。もう一度お試しください。",
    timeout: "ログインが時間切れになりました。もう一度開始してください。",
    browser: "ブラウザを開けませんでした。既定のブラウザの設定を確認してください。",
    unavailable: "このアプリでは接続設定を利用できません。アプリを更新してください。",
  },
  en: {
    title: "Settings",
    close: "Close settings",
    workspaceLabel: "Folder to allow access to",
    loading: "Checking connection settings…",
    description: "Sign in to OpenAI and review the operations allowed in the selected workspace.",
    signIn: "Sign in to OpenAI",
    reconnect: "Sign in again",
    authPresent: "Sign-in information is available.",
    authMissing: "Sign in for autonomous execution.",
    waiting: "Complete sign-in and allow the connection on the OpenAI page in your browser.",
    cancelling: "Cancelling sign-in…",
    cancel: "Cancel sign-in",
    cancelled: "Sign-in cancelled.",
    model: "Model",
    permissions: "Allowed operations in the selected workspace",
    read: "Read files",
    write: "Create and change files",
    info: "Inspect the workspace overview",
    validate: "Validate JSON files",
    gitStatus: "Read Git status",
    gitDiff: "Read Git diff",
    projectCheck: "Run project checks",
    projectTest: "Run project tests",
    projectBuild: "Run project build",
    projectCommands:
      "Checks, tests and builds execute scripts and code from the selected project. Even with file changes turned Off, they can create or change files and perform other actions with your account's access. Allow each operation separately.",
    save: "Save and use for autonomous execution",
    saving: "Saving…",
    scope:
      "Save the operations allowed for autonomous execution. Direct file reading and editing stay within the selected workspace. Use the switch above to turn execution On or Off.",
    workspace: "Choose a workspace first.",
    legacy:
      "Earlier development settings are present. Review permissions and save to switch to the runtime included with the app.",
    runtime: "The autonomous runtime could not be loaded. Update or reinstall the app.",
    retry: "Recheck connection status",
    checking: "Checking connection status…",
    retryHint: "Refresh sign-in and runtime status. This does not save changes to your settings.",
    failed: "Sign-in or setup failed. Please try again.",
    timeout: "Sign-in timed out. Start it again when ready.",
    browser: "The browser could not be opened. Check your default browser settings.",
    unavailable: "Connection setup is unavailable in this app. Please update it.",
  },
};

export function PiSetup({
  cwd,
  language,
  open = true,
  panelId,
  onClose,
  onConfigured,
  onReadinessChange,
  onAttentionChange,
}: PiSetupProps) {
  const copy = COPY[language];
  const setup = usePiSetup(cwd);
  const { status } = setup;
  const callbacks = useRef({ onConfigured, onClose });
  callbacks.current = { onConfigured, onClose };
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  const [model, setModel] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [commands, setCommands] = useState<readonly PiCommandPreset[]>([]);
  const dirty = useRef(false);
  const modelDirty = useRef(false);
  const reviewedCwd = useRef(cwd);
  useEffect(() => {
    if (reviewedCwd.current === cwd) return;
    reviewedCwd.current = cwd;
    dirty.current = false;
    modelDirty.current = false;
    setRead(true);
    setWrite(false);
    setCommands([]);
    setModel("");
  }, [cwd]);
  const id = useId();
  const ready = setupReady(status);
  const workspaceName =
    cwd
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ||
    cwd ||
    "";
  const active = loginActive(status?.login);
  useEffect(() => {
    onReadinessChange?.(ready);
  }, [ready, onReadinessChange]);
  useEffect(() => {
    if (!status) return;
    // 権限の確認後もモデル一覧を初期化し、明示的に選んだモデルは保持する。
    if (!modelDirty.current) {
      setModel(
        status.models.some((item) => item.id === status.model)
          ? status.model
          : (status.models[0]?.id ?? ""),
      );
    }
    if (dirty.current) return;
    setRead(status.permissions.read);
    setWrite(status.permissions.write);
    setCommands(status.permissions.commands);
  }, [status]);
  const error = setup.error ?? status?.login.code ?? status?.code;
  const attention = !setup.loading && (!ready || Boolean(error));
  useEffect(() => {
    onAttentionChange?.(attention);
  }, [attention, onAttentionChange]);
  const message = (value: PiSetupCode) => {
    if (
      ["runtime_unavailable", "runtime_invalid", "node_unavailable", "node_invalid"].includes(value)
    )
      return copy.runtime;
    if (value === "setup_unavailable") return copy.unavailable;
    if (value === "login_timeout") return copy.timeout;
    if (value === "browser_unavailable") return copy.browser;
    if (value === "workspace_unavailable") return copy.workspace;
    if (value === "login_cancelled") return copy.cancelled;
    return copy.failed;
  };
  const selectCommand = (command: PiCommandPreset, enabled: boolean) => {
    dirty.current = true;
    setCommands((current) =>
      enabled
        ? [...current.filter((item) => item !== command), command]
        : current.filter((item) => item !== command),
    );
  };
  const save = async () => {
    const saved = await setup.save({
      version: 2,
      enabled: true,
      provider: "openai",
      model,
      authMode: "oauth",
      permissions: { read, write, commands },
    });
    if (saved) {
      dirty.current = false;
      modelDirty.current = false;
      callbacks.current.onConfigured?.();
      callbacks.current.onClose?.();
    }
  };
  const canSave =
    status?.runtimeReady &&
    status.authenticated &&
    status.workspaceAvailable &&
    status.models.some((item) => item.id === model) &&
    !active &&
    !setup.busy;
  return (
    <section className="pi-setup" id={panelId} hidden={!open} aria-labelledby={`${id}-title`}>
      <div className="pi-setup-heading">
        <h2 id={`${id}-title`}>{copy.title}</h2>
        {onClose ? (
          <button type="button" ref={closeRef} aria-label={copy.close} onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {setup.loading ? <p role="status">{copy.loading}</p> : null}
      {!setup.loading ? (
        <div className="pi-setup-form">
          <p>{copy.description}</p>
          {cwd ? (
            <p>
              {copy.workspaceLabel}: <strong>{workspaceName}</strong>
            </p>
          ) : null}
          {status?.legacyConfiguration ? <p>{copy.legacy}</p> : null}
          {!status?.workspaceAvailable ? <p>{copy.workspace}</p> : null}
          {status?.runtimeReady ? (
            <>
              <p>{status.authenticated ? copy.authPresent : copy.authMissing}</p>
              {active ? (
                <div>
                  <p role="status">
                    {status.login.phase === "cancelling" ? copy.cancelling : copy.waiting}
                  </p>
                  <button
                    type="button"
                    disabled={setup.busy || status.login.phase === "cancelling"}
                    onClick={() => void setup.cancel()}
                  >
                    {copy.cancel}
                  </button>
                </div>
              ) : (
                <button type="button" disabled={setup.busy} onClick={() => void setup.login()}>
                  {status.authenticated ? copy.reconnect : copy.signIn}
                </button>
              )}
              <label htmlFor={`${id}-model`}>{copy.model}</label>
              <select
                id={`${id}-model`}
                value={model}
                disabled={setup.busy}
                onChange={(event) => {
                  modelDirty.current = true;
                  setModel(event.target.value);
                }}
              >
                {status.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <fieldset disabled={setup.busy}>
                <legend>{copy.permissions}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={read}
                    onChange={(event) => {
                      dirty.current = true;
                      setRead(event.target.checked);
                    }}
                  />
                  {copy.read}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={write}
                    onChange={(event) => {
                      dirty.current = true;
                      setWrite(event.target.checked);
                    }}
                  />
                  {copy.write}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={commands.includes("workspace-info")}
                    onChange={(event) => selectCommand("workspace-info", event.target.checked)}
                  />
                  {copy.info}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={commands.includes("validate-json")}
                    onChange={(event) => selectCommand("validate-json", event.target.checked)}
                  />
                  {copy.validate}
                </label>
                {(
                  [
                    ["git-status", copy.gitStatus],
                    ["git-diff", copy.gitDiff],
                  ] as const
                ).map(([command, label]) => (
                  <label key={command}>
                    <input
                      type="checkbox"
                      checked={commands.includes(command)}
                      onChange={(event) => selectCommand(command, event.target.checked)}
                    />
                    {label}
                  </label>
                ))}
                <p id={`${id}-project-commands`}>{copy.projectCommands}</p>
                {(
                  [
                    ["project-check", copy.projectCheck],
                    ["project-test", copy.projectTest],
                    ["project-build", copy.projectBuild],
                  ] as const
                ).map(([command, label]) => (
                  <label key={command}>
                    <input
                      type="checkbox"
                      aria-describedby={`${id}-project-commands`}
                      checked={commands.includes(command)}
                      onChange={(event) => selectCommand(command, event.target.checked)}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <p>{copy.scope}</p>
              <button type="button" disabled={!canSave} onClick={() => void save()}>
                {setup.busy && !active ? copy.saving : copy.save}
              </button>
            </>
          ) : (
            <p>{copy.runtime}</p>
          )}
          <button
            type="button"
            disabled={setup.busy || setup.loading || setup.checking}
            aria-busy={setup.checking || undefined}
            aria-describedby={`${id}-refresh-hint`}
            onClick={() => void setup.refresh()}
          >
            <span role={setup.checking ? "status" : undefined}>
              {setup.checking ? copy.checking : copy.retry}
            </span>
          </button>
          <p id={`${id}-refresh-hint`}>{copy.retryHint}</p>
        </div>
      ) : null}
      {error ? (
        <p className="pi-setup-error" role="alert">
          {message(error)}
        </p>
      ) : null}
    </section>
  );
}
