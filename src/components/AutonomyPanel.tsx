import { open as choosePath } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FolderOpen, Mic, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type AutonomyPanelLanguage,
  autonomyPanelLocale,
  autonomyPanelText,
} from "../i18n/autonomy-panel";
import {
  approvePendingWork,
  consultAutonomy,
  declinePendingWork,
  pauseAutonomy,
  runAutonomyNow,
  saveAutonomyContract,
  setAutonomyEnabled,
  undoAutonomyRun,
  useAutonomyDraftSnapshot,
  useAutonomyStatus,
} from "../runtime/autonomy/client";
import { type DraftField, useAutonomyDraftEditor } from "../runtime/autonomy/draft-editor";
import type { AutonomyOperation, SetupMessage } from "../runtime/autonomy/types";
import {
  AUTONOMY_VOICE_SETUP_REQUEST,
  AUTONOMY_VOICE_SETUP_STATUS,
  type AutonomyVoiceSetupStatus,
} from "../runtime/autonomy/voice-setup";
import "./AutonomyPanel.css";
import { AutonomyActionReview } from "./AutonomyActionReview";

const OPERATIONS: ReadonlyArray<{ id: AutonomyOperation; label: string }> = [
  { id: "write", label: "作成・編集" },
  { id: "move", label: "移動" },
  { id: "trash", label: "退避" },
];

const PHASE_LABELS = {
  idle: "次の作業を待っています",
  thinking: "目的に沿って次の仕事を考えています",
  applying: "復元できる状態を確保して変更しています",
  stopping: "作業プロセスの終了を待っています",
  paused: "一時停止中",
  failed: "作業を停止しました",
  completed: "今回の作業が終わりました",
  blocked: "続けるための指示を待っています",
  awaitingReview: "今日の仕事について相談しています",
  awaitingAction: "作業結果の確認を待っています",
  executingAction: "承認した操作を実行しています",
  publishing: "以前の処理状況を確認してください",
};

const RUN_LABELS = {
  running: "作業中",
  completed: "完了",
  failed: "失敗",
  cancelled: "中断",
  undone: "元に戻しました",
  proposed: "提案",
};

const OPEN_EVENT = "yorishiro:autonomy-setup-requested";
const START_CONVERSATION = "おまかせ作業の目的と範囲を相談したいです。質問から始めてください。";
const DRAFT_LABELS: Record<DraftField, string> = {
  goal: "目的",
  root: "フォルダ",
  allowedOperations: "許可する操作",
  intervalMinutes: "確認する間隔",
  maxRunsPerDay: "実行上限",
  reviewMode: "進め方",
  workMode: "任せる仕事の種類",
  publishPullRequest: "PRの公開",
  automaticActionApproval: "目的達成に必要な操作の自動許可",
};

/** Opens the host dialog only; never creates or enables an agreement. */
export function requestAutonomySetup(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ConversationMessage extends SetupMessage {
  readonly id: number;
}

/** Host-owned scope agreement and recovery UI. AI suggestions never grant permission. */
export function AutonomyPanel({
  language = "ja",
}: {
  readonly language?: AutonomyPanelLanguage;
} = {}) {
  const t = autonomyPanelText(language);
  const locale = autonomyPanelLocale(language);
  const status = useAutonomyStatus();
  const proposedDraft = useAutonomyDraftSnapshot();
  const { editor, state: draftState } = useAutonomyDraftEditor(proposedDraft, status?.contract);
  const {
    goal,
    root,
    allowedOperations: operations,
    intervalMinutes,
    maxRunsPerDay,
    reviewMode,
    automaticActionApproval,
  } = draftState.values;
  const explanation = draftState.explanation;
  const setGoal = (value: string) => editor.edit("goal", value);
  const setRoot = (value: string) => editor.edit("root", value);
  const setIntervalMinutes = (value: number) => editor.edit("intervalMinutes", value);
  const setMaxRunsPerDay = (value: number) =>
    editor.edit(
      "maxRunsPerDay",
      Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1)),
      ),
    );
  const setReviewMode = (value: "automatic" | "daily") => editor.edit("reviewMode", value);
  const setOperations = (next: (current: AutonomyOperation[]) => AutonomyOperation[]) =>
    editor.edit("allowedOperations", next([...editor.getSnapshot().values.allowedOperations]));
  const [visible, setVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [consultationOpen, setConsultationOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<AutonomyVoiceSetupStatus | null>(null);
  const voiceRequestId = useRef<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const nextMessageId = useRef(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const saveHintId = useId();
  const automaticRiskId = useId();
  const working =
    status?.phase === "thinking" ||
    status?.phase === "applying" ||
    status?.phase === "publishing" ||
    status?.phase === "executingAction" ||
    status?.pendingActions?.some((action) => action.status === "executing");
  const stopping = status?.phase === "stopping";
  const reviewActions = status?.pendingActions ?? [];
  const pendingActions = reviewActions.filter((action) => action.status === "pending");
  const decidedActions = reviewActions.filter((action) => action.status !== "pending");
  const confirmationCount = pendingActions.length;
  const firstPendingId = pendingActions[0]?.id;
  const launcherState = working || stopping ? "working" : status?.contract?.enabled ? "on" : "off";
  const launcherDescription = [
    stopping
      ? t("停止処理中")
      : working
        ? t("実行中")
        : t("自動作業 {state}", { state: status?.contract?.enabled ? "On" : "Off" }),
    confirmationCount > 0
      ? t("承認待ち {count}件", { count: confirmationCount })
      : status?.pendingWork
        ? t("今日の仕事を相談")
        : null,
  ]
    .filter(Boolean)
    .join(t("・"));
  const awaitingAction = reviewActions.some((action) =>
    ["pending", "approved", "executing"].includes(action.status),
  );
  const reviewRef = useRef<HTMLElement>(null);
  const settingsVisible = settingsOpen ?? (!status?.contract || Boolean(proposedDraft.draft));
  const sortedRuns = [...(status?.runs ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const displayedRuns = showAllRuns ? sortedRuns : sortedRuns.slice(0, 3);

  useEffect(() => {
    if (proposedDraft.draft?.id) setSettingsOpen(true);
  }, [proposedDraft.draft?.id]);

  useEffect(() => {
    if (!visible) return;
    panelRef.current?.focus();
    return () => openerRef.current?.focus();
  }, [visible]);

  useEffect(() => {
    if (!visible || !firstPendingId || !reviewRef.current) return;
    // Announce the ready review on opening, but never interrupt active editing.
    if (document.activeElement === panelRef.current || document.activeElement === document.body) {
      reviewRef.current.scrollIntoView?.({ block: "start", behavior: "smooth" });
      reviewRef.current.focus();
    }
  }, [visible, firstPendingId]);

  const openPanel = useCallback(() => {
    setError(null);
    setNotice(null);
    setVisible(true);
  }, []);

  useEffect(() => {
    window.addEventListener(OPEN_EVENT, openPanel);
    return () => window.removeEventListener(OPEN_EVENT, openPanel);
  }, [openPanel]);

  useEffect(() => {
    const onVoiceStatus = (event: Event) => {
      const next = (event as CustomEvent<AutonomyVoiceSetupStatus>).detail;
      if (!next || next.requestId !== voiceRequestId.current) return;
      setVoiceStatus(next);
    };
    window.addEventListener(AUTONOMY_VOICE_SETUP_STATUS, onVoiceStatus);
    return () => window.removeEventListener(AUTONOMY_VOICE_SETUP_STATUS, onVoiceStatus);
  }, []);

  async function startVoiceConversation() {
    if (busy) return;
    await act("voice", async () => {
      await editor.flush();
      const requestId = crypto.randomUUID();
      voiceRequestId.current = requestId;
      setVoiceStatus({ requestId, phase: "starting", message: t("音声での相談を開始しています…") });
      setError(null);
      window.dispatchEvent(
        new CustomEvent(AUTONOMY_VOICE_SETUP_REQUEST, { detail: { requestId, language } }),
      );
    });
  }

  async function act(name: string, action: () => Promise<void>, success?: string) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function consult(context?: string) {
    const text = context || message.trim() || t(START_CONVERSATION);
    if (busy) return;
    const history: ConversationMessage[] = [
      ...messages,
      { id: nextMessageId.current++, role: "user" as const, content: text },
    ].slice(-11);
    setMessages(history);
    setMessage("");
    await act("consult", async () => {
      await editor.flush();
      const answer = await consultAutonomy(
        history.map(({ role, content }) => ({ role, content })),
        language,
      );
      setMessages([
        ...history,
        { id: nextMessageId.current++, role: "assistant", content: answer.reply },
      ]);
      if (answer.draftConflict)
        setNotice(
          t(
            "相談中に設定案が更新されました。今の入力を残しています。変更したい内容をもう一度相談できます。",
          ),
        );
      // The consultation publishes into the same shared draft. Native draft
      // events reconcile fields without overwriting pending human edits.
    });
  }

  async function selectRoot() {
    await act("folder", async () => {
      const selected = await choosePath({
        directory: true,
        multiple: false,
        title: t("任せるフォルダ"),
      });
      if (typeof selected === "string") setRoot(selected);
    });
  }

  function conflictFor(field: DraftField) {
    if (!draftState.conflicts.includes(field)) return null;
    const value = draftState.remoteValues[field];
    const remoteText =
      field === "allowedOperations"
        ? OPERATIONS.filter(({ id }) => Array.isArray(value) && value.includes(id))
            .map(({ label }) => t(label))
            .join(t("、"))
        : field === "reviewMode"
          ? value === "daily"
            ? t("その日の仕事を先に相談")
            : t("範囲内で自動的に進める")
          : String(value);
    return (
      <fieldset
        className="autonomy-field-conflict"
        aria-label={t("{field}の更新を確認", { field: t(DRAFT_LABELS[field]) })}
      >
        <p>{t("AIもこの項目を更新しました。入力した内容は保持しています。")}</p>
        <p className="autonomy-muted">
          {t("AIの案:")} {remoteText || t("未設定")}
        </p>
        <div className="autonomy-conversation-actions">
          <button type="button" onClick={() => editor.resolve(field, "remote")}>
            {t("AIの案を使う")}
          </button>
          <button type="button" onClick={() => editor.resolve(field, "local")}>
            {t("自分の入力を残す")}
          </button>
        </div>
      </fieldset>
    );
  }

  return (
    <>
      <button
        type="button"
        ref={openerRef}
        className="title-bar-button autonomy-launcher"
        data-autonomy-state={launcherState}
        title={`${t("おまかせ作業")}${t("・")}${launcherDescription}`}
        aria-description={launcherDescription}
        aria-haspopup="dialog"
        aria-label={
          confirmationCount > 0
            ? t("おまかせ作業 確認待ち {count}件", { count: confirmationCount })
            : t("おまかせ作業")
        }
        aria-expanded={visible}
        onClick={openPanel}
      >
        <span className="autonomy-launcher-label" aria-hidden="true">
          AUTO
        </span>
        {confirmationCount > 0 ? (
          <span className="autonomy-launcher-count" aria-hidden="true">
            {confirmationCount > 99 ? "99+" : confirmationCount}
          </span>
        ) : (
          <span className="autonomy-launcher-state" aria-hidden="true" />
        )}
      </button>
      {visible &&
        createPortal(
          <div className="autonomy-overlay">
            <div
              className="autonomy-panel"
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") setVisible(false);
                if (event.key !== "Tab") return;
                const controls = Array.from(
                  panelRef.current?.querySelectorAll<HTMLElement>(
                    "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary",
                  ) ?? [],
                ).filter((control) => {
                  let collapsed = control.closest("details:not([open])");
                  while (collapsed) {
                    if (!collapsed.querySelector(":scope > summary")?.contains(control))
                      return false;
                    collapsed = collapsed.parentElement?.closest("details:not([open])") ?? null;
                  }
                  return true;
                });
                if (!controls?.length) return;
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (
                  event.shiftKey &&
                  (document.activeElement === first || document.activeElement === panelRef.current)
                ) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }}
            >
              <header className="autonomy-header">
                <div>
                  <h2 id={titleId}>{t("おまかせ作業")}</h2>
                  <p className="autonomy-muted">{t("作業の目的・範囲・実行状況を管理")}</p>
                </div>
                <button
                  className="autonomy-close"
                  type="button"
                  onClick={() => setVisible(false)}
                  aria-label={t("おまかせ作業を閉じる")}
                  title={t("閉じる（Esc）")}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </header>
              <div className="autonomy-body">
                {(error || status?.error) && (
                  <p className="autonomy-error" role="alert">
                    {error || status?.error}
                  </p>
                )}
                {status === null ? (
                  <p role="status">{t("設定を読み込んでいます…")}</p>
                ) : (
                  <>
                    {status.contract && (
                      <section className="autonomy-status" aria-label={t("作業状況")}>
                        <div className="autonomy-mission">
                          <span className="autonomy-section-caption">
                            {t("今、任せていること")}
                          </span>
                          <h3>{status.contract.goal}</h3>
                          <p className="autonomy-path" title={status.contract.root}>
                            {status.contract.root}
                          </p>
                          {status.contract.automaticActionApproval && (
                            <p className="autonomy-saved-permission">
                              <AlertTriangle size={14} aria-hidden="true" />
                              {t("必要な操作は個別確認なしで実行")}
                            </p>
                          )}
                        </div>
                        <div className="autonomy-status-copy">
                          <p role="status">
                            <span
                              aria-hidden="true"
                              className={
                                working || stopping
                                  ? "autonomy-dot autonomy-dot-active"
                                  : "autonomy-dot"
                              }
                            />
                            {status.phase === "executingAction"
                              ? t(PHASE_LABELS.executingAction)
                              : status.phase === "publishing"
                                ? t(PHASE_LABELS.publishing)
                                : working
                                  ? status.phase === "applying"
                                    ? t("作業の成果を保存しています")
                                    : t("目的に沿った作業と検証を進めています")
                                  : status.phase === "awaitingAction" &&
                                      confirmationCount === 0 &&
                                      awaitingAction
                                    ? t("承認した操作の実行を準備しています")
                                    : t(PHASE_LABELS[status.phase])}
                          </p>
                          {status.nextRunAt !== null &&
                            status.contract.enabled &&
                            !status.pendingWork &&
                            !awaitingAction && (
                              <p className="autonomy-muted">
                                {t("次回:")} {new Date(status.nextRunAt).toLocaleString(locale)}
                              </p>
                            )}
                        </div>
                        <div className="autonomy-actions">
                          <div className="autonomy-toggle">
                            <span>{t("自動作業")}</span>
                            <button
                              type="button"
                              role="switch"
                              className="autonomy-settings-toggle"
                              aria-checked={status.contract.enabled}
                              aria-label={t("自動作業")}
                              disabled={stopping || busy !== null}
                              onClick={() => {
                                if (!status.contract) return;
                                const enabled = !status.contract.enabled;
                                void act("toggle", () => setAutonomyEnabled(enabled));
                              }}
                            >
                              <span className="autonomy-switch-thumb" aria-hidden="true" />
                            </button>
                            <span aria-hidden="true">{status.contract.enabled ? "On" : "Off"}</span>
                          </div>
                          {(working || stopping) && (
                            <button
                              type="button"
                              disabled={stopping || busy === "pause"}
                              onClick={() => void act("pause", pauseAutonomy)}
                            >
                              {t("一時停止")}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={
                              working ||
                              stopping ||
                              busy !== null ||
                              status.pendingWork != null ||
                              awaitingAction
                            }
                            onClick={() => void act("run", runAutonomyNow)}
                          >
                            {t("今すぐ進める")}
                          </button>
                        </div>
                      </section>
                    )}
                    {pendingActions.length > 0 && (
                      <section
                        className="autonomy-confirmations"
                        aria-label={t("承認待ち")}
                        ref={reviewRef}
                        tabIndex={-1}
                      >
                        <div className="autonomy-history-heading">
                          <h3>{t("承認待ち")}</h3>
                          <span className="autonomy-count">
                            {t("{count}件", { count: pendingActions.length })}
                          </span>
                        </div>
                        {pendingActions.map((action) => (
                          <AutonomyActionReview
                            key={`${action.id}:${action.payloadDigest}`}
                            action={action}
                            language={language}
                            disabled={busy !== null || working || stopping}
                          />
                        ))}
                      </section>
                    )}
                    {status.pendingWork && (
                      <section className="autonomy-today" aria-label={t("今日の仕事の相談")}>
                        <h3>{t("今日、進めたい仕事")}</h3>
                        <p>{status.pendingWork.goal}</p>
                        <p>{status.pendingWork.summary}</p>
                        <p className="autonomy-muted">{status.pendingWork.reason}</p>
                        {status.pendingWork.changedPaths.length > 0 && (
                          <ul>
                            {status.pendingWork.changedPaths.map((path) => (
                              <li key={path} className="autonomy-path">
                                {path}
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="autonomy-muted">
                          {t("この仕事を任せると、継続して許可した範囲内で進めます。")}
                        </p>
                        <div className="autonomy-actions">
                          <button
                            type="button"
                            className="autonomy-primary"
                            disabled={busy !== null || working}
                            onClick={() => {
                              const id = status.pendingWork?.id;
                              if (id)
                                void act(
                                  "approve",
                                  () => approvePendingWork(id),
                                  t("今日の仕事を任せました。"),
                                );
                            }}
                          >
                            {t("この仕事を任せる")}
                          </button>
                          <button
                            type="button"
                            disabled={busy !== null || working}
                            onClick={() => {
                              const id = status.pendingWork?.id;
                              if (id)
                                void act(
                                  "decline",
                                  () => declinePendingWork(id),
                                  t("今回は見送りました。"),
                                );
                            }}
                          >
                            {t("今回は見送る")}
                          </button>
                        </div>
                      </section>
                    )}
                    <details
                      className="autonomy-settings"
                      open={settingsVisible}
                      onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
                    >
                      <summary>{t("設定")}</summary>
                      <div className="autonomy-workspace">
                        <form
                          className="autonomy-scope"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (!draftState.synced) return;
                            void act(
                              "save",
                              () =>
                                saveAutonomyContract(
                                  {
                                    goal: goal.trim(),
                                    root,
                                    allowedOperations: operations,
                                    intervalMinutes,
                                    maxRunsPerDay,
                                    reviewMode,
                                    workMode: "auto",
                                    publishPullRequest: false,
                                    automaticActionApproval,
                                    enabled: true,
                                  },
                                  draftState.draftId,
                                ),
                              t("この範囲で作業を開始します。範囲はいつでも変更できます。"),
                            );
                          }}
                        >
                          <h3>{t("任せる範囲")}</h3>
                          <label className="autonomy-field">
                            {t("任せる目的")}
                            <textarea
                              value={goal}
                              onChange={(event) => setGoal(event.target.value)}
                              rows={3}
                              required
                              maxLength={2000}
                            />
                          </label>
                          {conflictFor("goal")}
                          <div className="autonomy-folder-row">
                            <label className="autonomy-field">
                              {t("対象フォルダ")}
                              <input
                                value={root}
                                onChange={(event) => setRoot(event.target.value)}
                                placeholder={t("会話で決めたフォルダ")}
                              />
                            </label>
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void selectRoot()}
                            >
                              <FolderOpen size={16} aria-hidden="true" />
                              {t("フォルダを選ぶ")}
                            </button>
                          </div>
                          {conflictFor("root")}
                          <fieldset className="autonomy-review-options" disabled={busy === "save"}>
                            <legend>{t("進め方")}</legend>
                            <label className="autonomy-check">
                              <input
                                type="radio"
                                name="autonomy-review-mode"
                                checked={reviewMode === "daily"}
                                onChange={() => setReviewMode("daily")}
                              />
                              {t("その日の仕事を先に相談")}
                            </label>
                            <label className="autonomy-check">
                              <input
                                type="radio"
                                name="autonomy-review-mode"
                                checked={reviewMode === "automatic"}
                                onChange={() => setReviewMode("automatic")}
                              />
                              {t("範囲内で自動的に進める")}
                            </label>
                          </fieldset>
                          {conflictFor("reviewMode")}
                          <fieldset className="autonomy-auto-permission" disabled={busy === "save"}>
                            <legend>{t("実行時の確認")}</legend>
                            <label className="autonomy-check">
                              <input
                                type="checkbox"
                                checked={automaticActionApproval}
                                aria-describedby={
                                  automaticActionApproval ? automaticRiskId : undefined
                                }
                                onChange={(event) =>
                                  editor.edit("automaticActionApproval", event.target.checked)
                                }
                              />
                              {t("目的達成に必要な操作を自動で許可する")}
                            </label>
                          </fieldset>
                          {automaticActionApproval ? (
                            <div
                              className="autonomy-permission-risk"
                              role="note"
                              id={automaticRiskId}
                            >
                              <AlertTriangle size={19} aria-hidden="true" />
                              <div>
                                <strong>{t("実行前の確認を省略します")}</strong>
                                <p>
                                  {t(
                                    "目的の達成に必要な外部送信・公開も、操作ごとの確認なしで実行します。必要に応じてサービスの保存済みログインを使います。",
                                  )}
                                </p>
                                <p>
                                  {t(
                                    "送信や公開など、取り消せない変更があります。対象・内容・実行結果は履歴に残ります。",
                                  )}
                                </p>
                                <p>{t("オフにすると、必要な操作をその都度確認します。")}</p>
                              </div>
                            </div>
                          ) : (
                            <p className="autonomy-muted">
                              {t("外部送信・公開などの操作は、対象と内容をその都度確認します。")}
                            </p>
                          )}
                          {automaticActionApproval &&
                            OPERATIONS.some((operation) => !operations.includes(operation.id)) && (
                              <p className="autonomy-muted">
                                {t(
                                  "外部送信などツールを使う操作には、作成・編集／移動／退避の許可が必要です。",
                                )}
                              </p>
                            )}
                          {conflictFor("automaticActionApproval")}
                          {!draftState.synced && (
                            <p className="autonomy-muted" role="status">
                              {draftState.error
                                ? t("編集内容をAIに反映できませんでした。")
                                : draftState.conflicts.length > 0
                                  ? t("同じ項目の更新を確認してください。")
                                  : t("編集内容をAIに反映しています…")}
                            </p>
                          )}
                          {draftState.error && (
                            <div role="alert" className="autonomy-error">
                              <p>{draftState.error}</p>
                              <button type="button" onClick={() => editor.retry()}>
                                {t("反映を再試行")}
                              </button>
                            </div>
                          )}

                          {explanation && (
                            <details className="autonomy-draft-proposal">
                              <summary>{t("AIからの提案を見る")}</summary>
                              <p className="autonomy-draft-explanation">{explanation}</p>
                            </details>
                          )}
                          <details className="autonomy-advanced">
                            <summary>{t("詳細設定")}</summary>
                            <fieldset className="autonomy-permissions" disabled={busy === "save"}>
                              <legend>{t("自動で進めてよい操作")}</legend>
                              {OPERATIONS.map((operation) => (
                                <label key={operation.id} className="autonomy-check">
                                  <input
                                    type="checkbox"
                                    checked={operations.includes(operation.id)}
                                    onChange={(event) =>
                                      setOperations((current) =>
                                        event.target.checked
                                          ? [...current, operation.id]
                                          : current.filter((id) => id !== operation.id),
                                      )
                                    }
                                  />
                                  {t(operation.label)}
                                </label>
                              ))}
                            </fieldset>
                            <p className="autonomy-muted">
                              {t(
                                "コード変更を任せる場合は3項目すべてを許可してください。許可していない操作は行いません。",
                              )}
                            </p>
                            {conflictFor("allowedOperations")}
                            <div className="autonomy-numbers">
                              <label className="autonomy-field">
                                {t("確認する間隔（分）")}
                                <input
                                  type="number"
                                  min={5}
                                  max={1440}
                                  required
                                  value={intervalMinutes}
                                  onChange={(event) =>
                                    setIntervalMinutes(Number(event.target.value))
                                  }
                                />
                              </label>
                              <label className="autonomy-field">
                                {t("24時間の実行上限（回）")}
                                <input
                                  type="number"
                                  min={1}
                                  max={Number.MAX_SAFE_INTEGER}
                                  required
                                  value={maxRunsPerDay}
                                  onChange={(event) => setMaxRunsPerDay(Number(event.target.value))}
                                />
                              </label>
                            </div>
                            <p className="autonomy-muted">
                              {t("24時間の実行上限は1以上の整数で設定できます。")}
                            </p>
                            {conflictFor("intervalMinutes")}
                            {conflictFor("maxRunsPerDay")}
                            <details className="autonomy-help">
                              <summary>{t("作業の範囲と実行条件")}</summary>
                              <p className="autonomy-muted">
                                {t(
                                  "目的に沿って必要な仕事を選び、実行と検証まで進めます。 Gitリポジトリではコミット済みの内容を別の作業場所に複製し、文書やコードの改善・テストを行います。未コミットの変更は含みません。 通常のフォルダではテキスト文書を整理・編集します。",
                                )}
                              </p>
                              <p className="autonomy-muted">
                                {t(
                                  "変更は復元できる形で保存し、作業結果と検証内容を履歴に残します。 必要な依存関係や認証がなければ停止して知らせます。",
                                )}
                              </p>
                              <p className="autonomy-muted">
                                {t(
                                  "Gitリポジトリでの作業にはCodex、通常のフォルダでの文書作業にはClaude Codeへのログインが必要です。 Yorishiroを開いている間に動作し、AIの利用枠を消費します。 目的達成に必要な操作の自動許可には、Claude CodeとCodexへのログインが必要です。必要な外部送信・公開も自動で進めます。 許可しない場合は、具体的な対象と内容を個別に確認します。",
                                )}
                              </p>
                            </details>
                          </details>
                          <div className="autonomy-save-row">
                            <p id={saveHintId} className="autonomy-muted">
                              {operations.length === 0
                                ? t("詳細設定で許可する操作を選んでください。")
                                : t(
                                    "「この範囲で任せる」を押すと、設定を保存して自動作業を有効にします。",
                                  )}
                            </p>
                            <button
                              className="autonomy-primary"
                              type="submit"
                              aria-describedby={saveHintId}
                              disabled={
                                busy !== null ||
                                !draftState.synced ||
                                !goal.trim() ||
                                !root ||
                                operations.length === 0
                              }
                            >
                              {busy === "save" ? t("保存しています…") : t("この範囲で任せる")}
                            </button>
                          </div>
                        </form>
                      </div>
                    </details>
                    <details
                      className="autonomy-consultation-disclosure"
                      open={consultationOpen}
                      onToggle={(event) => setConsultationOpen(event.currentTarget.open)}
                    >
                      <summary>{t("AIに相談")}</summary>
                      <section className="autonomy-consultation" aria-label={t("任せる範囲の相談")}>
                        <p className="autonomy-muted">
                          {t(
                            "会話で設定を更新できます。直接編集した内容も次の相談に反映されます。",
                          )}
                        </p>
                        <div className="autonomy-conversation-actions">
                          <button
                            className="autonomy-primary"
                            type="button"
                            disabled={busy !== null || voiceStatus?.phase === "starting"}
                            onClick={startVoiceConversation}
                          >
                            <Mic size={16} aria-hidden="true" />
                            {t("音声で相談する")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setTextOpen((current) => !current)}
                            aria-expanded={textOpen}
                          >
                            {t("文字で相談する")}
                          </button>
                        </div>
                        {voiceStatus && (
                          <p
                            role={voiceStatus.phase === "error" ? "alert" : "status"}
                            className={
                              voiceStatus.phase === "error" ? "autonomy-error" : "autonomy-muted"
                            }
                          >
                            {voiceStatus.message}
                          </p>
                        )}
                        {textOpen && (
                          <>
                            <div
                              className="autonomy-conversation"
                              role="log"
                              aria-label={t("相談の履歴")}
                            >
                              {messages.map((item) => (
                                <p
                                  key={item.id}
                                  className={`autonomy-message autonomy-message-${item.role}`}
                                >
                                  <strong>{item.role === "user" ? t("あなた") : "AI"}</strong>
                                  <br />
                                  {item.content}
                                </p>
                              ))}
                            </div>
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                void consult();
                              }}
                            >
                              <label className="autonomy-field">
                                {t("相談したいこと")}
                                <textarea
                                  value={message}
                                  onChange={(event) => setMessage(event.target.value)}
                                  maxLength={4000}
                                  rows={2}
                                  placeholder={t(
                                    "例えば、メモを読みやすく整理して、次に取り組むことをまとめてほしい",
                                  )}
                                />
                              </label>
                              <button type="submit" disabled={busy !== null}>
                                {busy === "consult" ? t("相談しています…") : t("AIと相談する")}
                              </button>
                            </form>
                          </>
                        )}
                      </section>
                    </details>
                    {decidedActions.length > 0 && (
                      <section aria-label={t("承認履歴")}>
                        <details className="autonomy-decisions">
                          <summary>
                            {t("承認履歴")}{" "}
                            <span className="autonomy-count">
                              {t("{count}件", { count: decidedActions.length })}
                            </span>
                          </summary>
                          {decidedActions.map((action) => (
                            <AutonomyActionReview
                              key={`${action.id}:${action.payloadDigest}`}
                              action={action}
                              language={language}
                              disabled={busy !== null || working || stopping}
                            />
                          ))}
                        </details>
                      </section>
                    )}
                    {status.runs.length > 0 && (
                      <section className="autonomy-history" aria-label={t("作業履歴")}>
                        <div className="autonomy-history-heading">
                          <h3>{t("作業履歴")}</h3>
                          <span className="autonomy-count">
                            {t("{count}件", { count: status.runs.length })}
                          </span>
                        </div>
                        {displayedRuns.map((run, index) => (
                          <article key={run.id}>
                            <div className="autonomy-run-meta">
                              <span className={`autonomy-run-badge autonomy-run-${run.status}`}>
                                {t(RUN_LABELS[run.status])}
                              </span>
                              <time dateTime={new Date(run.startedAt).toISOString()}>
                                {new Date(run.startedAt).toLocaleString(locale)}
                              </time>
                            </div>
                            <p className="autonomy-run-summary">
                              {run.summary
                                ? run.summary.length > 160
                                  ? `${run.summary.slice(0, 160)}…`
                                  : run.summary
                                : t("作業を進めています…")}
                            </p>
                            {reviewActions.filter(
                              (action) => action.runId === run.id && action.status === "declined",
                            ).length > 0 && (
                              <p className="autonomy-muted">
                                {t("この作業の確認事項は見送りました。")}
                              </p>
                            )}
                            {(run.status === "failed" ||
                              (status.phase === "blocked" && index === 0)) && (
                              <button
                                type="button"
                                disabled={busy !== null || working || stopping}
                                onClick={() => {
                                  setConsultationOpen(true);
                                  setTextOpen(true);
                                  void consult(
                                    t(
                                      "おまかせ作業の結果について相談したいです。必要な確認事項と次にできる操作を教えてください。公開や実行の承認ではありません。\n作業ID: {id}\n結果: {summary}\n理由: {reason}",
                                      { id: run.id, summary: run.summary, reason: run.reason },
                                    ),
                                  );
                                }}
                              >
                                {t("結果についてAIに相談")}
                              </button>
                            )}
                            {(run.summary.length > 160 ||
                              run.reason ||
                              run.developmentPath ||
                              run.branch ||
                              run.validationSummary ||
                              run.changedPaths.length > 0) && (
                              <details className="autonomy-run-details">
                                <summary>{t("詳細")}</summary>
                                {run.summary.length > 160 && <p>{run.summary}</p>}
                                {run.reason && <p className="autonomy-muted">{run.reason}</p>}
                                {run.developmentPath && (
                                  <p className="autonomy-path">
                                    {t("確認用の成果物:")} {run.developmentPath}
                                  </p>
                                )}
                                {run.branch && (
                                  <p className="autonomy-path">
                                    {t("ブランチ:")} {run.branch}
                                  </p>
                                )}
                                {run.validationSummary && (
                                  <p className="autonomy-muted">
                                    {t("検証:")} {run.validationSummary}
                                  </p>
                                )}
                                {run.changedPaths.length > 0 && (
                                  <ul>
                                    {run.changedPaths.map((path) => (
                                      <li key={path}>{path}</li>
                                    ))}
                                  </ul>
                                )}
                              </details>
                            )}
                            {run.canUndo && (
                              <button
                                type="button"
                                disabled={busy !== null || working}
                                onClick={() =>
                                  void act(
                                    `undo:${run.id}`,
                                    () => undoAutonomyRun(run.id),
                                    t("変更を元に戻しました。"),
                                  )
                                }
                              >
                                {t("この作業を元に戻す")}
                              </button>
                            )}
                          </article>
                        ))}
                        {sortedRuns.length > 3 && (
                          <button
                            type="button"
                            className="autonomy-show-history"
                            onClick={() => setShowAllRuns((current) => !current)}
                          >
                            {showAllRuns
                              ? t("最新3件を表示")
                              : t("すべて表示（{count}件）", { count: sortedRuns.length })}
                          </button>
                        )}
                      </section>
                    )}
                  </>
                )}
                {notice && (
                  <p className="autonomy-notice" role="status">
                    {notice}
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
