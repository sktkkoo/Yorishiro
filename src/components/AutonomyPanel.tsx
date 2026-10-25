import { open as choosePath } from "@tauri-apps/plugin-dialog";
import { FolderOpen, ListTodo, Mic, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
export function AutonomyPanel() {
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
  } = draftState.values;
  const explanation = draftState.explanation;
  const setGoal = (value: string) => editor.edit("goal", value);
  const setRoot = (value: string) => editor.edit("root", value);
  const setIntervalMinutes = (value: number) => editor.edit("intervalMinutes", value);
  const setMaxRunsPerDay = (value: number) => editor.edit("maxRunsPerDay", value);
  const setReviewMode = (value: "automatic" | "daily") => editor.edit("reviewMode", value);
  const setOperations = (next: (current: AutonomyOperation[]) => AutonomyOperation[]) =>
    editor.edit("allowedOperations", next([...editor.getSnapshot().values.allowedOperations]));
  const [visible, setVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  const [showAllRuns, setShowAllRuns] = useState(false);
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
  const working =
    status?.phase === "thinking" || status?.phase === "applying" || status?.phase === "publishing";
  const stopping = status?.phase === "stopping";
  const reviewActions = status?.pendingActions ?? [];
  const pendingActions = reviewActions.filter((action) => action.status === "pending");
  const decidedActions = reviewActions.filter((action) => action.status !== "pending");
  const confirmationCount = pendingActions.length;
  const firstPendingId = pendingActions[0]?.id;
  const launcherState = working || stopping ? "working" : status?.contract?.enabled ? "on" : "off";
  const launcherDescription = [
    stopping
      ? "停止処理中"
      : working
        ? "実行中"
        : `自動作業 ${status?.contract?.enabled ? "On" : "Off"}`,
    confirmationCount > 0
      ? `承認待ち ${confirmationCount}件`
      : status?.pendingWork
        ? "今日の仕事を相談"
        : null,
  ]
    .filter(Boolean)
    .join("・");
  const awaitingAction = reviewActions.some((action) => action.status !== "declined");
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
      setVoiceStatus({ requestId, phase: "starting", message: "音声での相談を開始しています…" });
      setError(null);
      window.dispatchEvent(
        new CustomEvent(AUTONOMY_VOICE_SETUP_REQUEST, { detail: { requestId } }),
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
    const text = context || message.trim() || START_CONVERSATION;
    if (busy) return;
    const history: ConversationMessage[] = [
      ...messages,
      { id: nextMessageId.current++, role: "user" as const, content: text },
    ].slice(-11);
    setMessages(history);
    setMessage("");
    await act("consult", async () => {
      await editor.flush();
      const answer = await consultAutonomy(history.map(({ role, content }) => ({ role, content })));
      setMessages([
        ...history,
        { id: nextMessageId.current++, role: "assistant", content: answer.reply },
      ]);
      if (answer.draftConflict)
        setNotice(
          "相談中に設定案が更新されました。今の入力を残しています。変更したい内容をもう一度相談できます。",
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
        title: "任せるフォルダ",
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
            .map(({ label }) => label)
            .join("、")
        : field === "reviewMode"
          ? value === "daily"
            ? "その日の仕事を先に相談"
            : "範囲内で自動的に進める"
          : String(value);
    return (
      <fieldset
        className="autonomy-field-conflict"
        aria-label={`${DRAFT_LABELS[field]}の更新を確認`}
      >
        <p>AIもこの項目を更新しました。入力した内容は保持しています。</p>
        <p className="autonomy-muted">AIの案: {remoteText || "未設定"}</p>
        <div className="autonomy-conversation-actions">
          <button type="button" onClick={() => editor.resolve(field, "remote")}>
            AIの案を使う
          </button>
          <button type="button" onClick={() => editor.resolve(field, "local")}>
            自分の入力を残す
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
        title={`おまかせ作業・${launcherDescription}`}
        aria-description={launcherDescription}
        aria-haspopup="dialog"
        aria-label={
          confirmationCount > 0 ? `おまかせ作業 確認待ち ${confirmationCount}件` : "おまかせ作業"
        }
        aria-expanded={visible}
        onClick={openPanel}
      >
        <ListTodo size={15} strokeWidth={1.8} aria-hidden="true" />
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
                  const collapsed = control.closest("details:not([open])");
                  return !collapsed || collapsed.querySelector(":scope > summary") === control;
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
                  <h2 id={titleId}>おまかせ作業</h2>
                  <p className="autonomy-muted">作業の目的・範囲・実行状況を管理</p>
                </div>
                <button
                  className="autonomy-close"
                  type="button"
                  onClick={() => setVisible(false)}
                  aria-label="おまかせ作業を閉じる"
                  title="閉じる（Esc）"
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
                  <p role="status">設定を読み込んでいます…</p>
                ) : (
                  <>
                    {status.contract && (
                      <section className="autonomy-status" aria-label="作業状況">
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
                            {status.phase === "publishing"
                              ? PHASE_LABELS.publishing
                              : working
                                ? status.phase === "applying"
                                  ? "作業の成果を保存しています"
                                  : "目的に沿った作業と検証を進めています"
                                : status.phase === "awaitingAction" &&
                                    confirmationCount === 0 &&
                                    awaitingAction
                                  ? "承認済みの操作についてAIへの引き継ぎを待っています"
                                  : PHASE_LABELS[status.phase]}
                          </p>
                          {status.nextRunAt !== null &&
                            status.contract.enabled &&
                            !status.pendingWork &&
                            !awaitingAction && (
                              <p className="autonomy-muted">
                                次回: {new Date(status.nextRunAt).toLocaleString("ja-JP")}
                              </p>
                            )}
                        </div>
                        <div className="autonomy-actions">
                          <label className="autonomy-toggle">
                            <input
                              type="checkbox"
                              role="switch"
                              aria-checked={status.contract.enabled}
                              aria-label="自動作業"
                              checked={status.contract.enabled}
                              disabled={stopping || busy !== null}
                              onChange={(event) => {
                                const enabled = event.currentTarget.checked;
                                void act("toggle", () => setAutonomyEnabled(enabled));
                              }}
                            />
                            自動作業 {status.contract.enabled ? "On" : "Off"}
                          </label>
                          {(working || stopping) && (
                            <button
                              type="button"
                              disabled={stopping || busy === "pause"}
                              onClick={() => void act("pause", pauseAutonomy)}
                            >
                              一時停止
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
                            今すぐ進める
                          </button>
                        </div>
                      </section>
                    )}
                    {pendingActions.length > 0 && (
                      <section
                        className="autonomy-confirmations"
                        aria-label="承認待ち"
                        ref={reviewRef}
                        tabIndex={-1}
                      >
                        <div className="autonomy-history-heading">
                          <h3>承認待ち</h3>
                          <span className="autonomy-count">{pendingActions.length}件</span>
                        </div>
                        {pendingActions.map((action) => (
                          <AutonomyActionReview
                            key={`${action.id}:${action.payloadDigest}`}
                            action={action}
                            disabled={busy !== null || working || stopping}
                          />
                        ))}
                      </section>
                    )}
                    {status.pendingWork && (
                      <section className="autonomy-today" aria-label="今日の仕事の相談">
                        <h3>今日、進めたい仕事</h3>
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
                          この仕事を任せると、継続して許可した範囲内で進めます。
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
                                  "今日の仕事を任せました。",
                                );
                            }}
                          >
                            この仕事を任せる
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
                                  "今回は見送りました。",
                                );
                            }}
                          >
                            今回は見送る
                          </button>
                        </div>
                      </section>
                    )}
                    <details
                      className="autonomy-settings"
                      open={settingsVisible}
                      onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
                    >
                      <summary>設定</summary>
                      <div className="autonomy-workspace">
                        <section className="autonomy-consultation" aria-label="任せる範囲の相談">
                          <h3>AIに相談</h3>
                          <p className="autonomy-muted">
                            会話で設定を更新できます。直接編集した内容も次の相談に反映されます。
                          </p>
                          <div className="autonomy-conversation-actions">
                            <button
                              className="autonomy-primary"
                              type="button"
                              disabled={busy !== null || voiceStatus?.phase === "starting"}
                              onClick={startVoiceConversation}
                            >
                              <Mic size={16} aria-hidden="true" />
                              音声で相談する
                            </button>
                            <button
                              type="button"
                              onClick={() => setTextOpen((current) => !current)}
                              aria-expanded={textOpen}
                            >
                              文字で相談する
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
                                aria-label="相談の履歴"
                              >
                                {messages.map((item) => (
                                  <p
                                    key={item.id}
                                    className={`autonomy-message autonomy-message-${item.role}`}
                                  >
                                    <strong>{item.role === "user" ? "あなた" : "AI"}</strong>
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
                                  相談したいこと
                                  <textarea
                                    value={message}
                                    onChange={(event) => setMessage(event.target.value)}
                                    maxLength={4000}
                                    rows={2}
                                    placeholder="例えば、メモを読みやすく整理して、次に取り組むことをまとめてほしい"
                                  />
                                </label>
                                <button type="submit" disabled={busy !== null}>
                                  {busy === "consult" ? "相談しています…" : "AIと相談する"}
                                </button>
                              </form>
                            </>
                          )}
                        </section>
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
                                    enabled: true,
                                  },
                                  draftState.draftId,
                                ),
                              "この範囲で作業を開始します。範囲はいつでも変更できます。",
                            );
                          }}
                        >
                          <h3>任せる範囲</h3>
                          {explanation && (
                            <p className="autonomy-draft-explanation">{explanation}</p>
                          )}
                          <label className="autonomy-field">
                            任せる目的
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
                              対象フォルダ
                              <input
                                value={root}
                                onChange={(event) => setRoot(event.target.value)}
                                placeholder="会話で決めたフォルダ"
                              />
                            </label>
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void selectRoot()}
                            >
                              <FolderOpen size={16} aria-hidden="true" />
                              フォルダを選ぶ
                            </button>
                          </div>
                          {conflictFor("root")}
                          <fieldset className="autonomy-permissions" disabled={busy === "save"}>
                            <legend>自動で進めてよい操作</legend>
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
                                {operation.label}
                              </label>
                            ))}
                          </fieldset>
                          <p className="autonomy-muted">
                            コード変更を任せる場合は3項目すべてを許可してください。許可していない操作は行いません。
                          </p>
                          {conflictFor("allowedOperations")}
                          <fieldset className="autonomy-review-options" disabled={busy === "save"}>
                            <legend>進め方</legend>
                            <label className="autonomy-check">
                              <input
                                type="radio"
                                name="autonomy-review-mode"
                                checked={reviewMode === "daily"}
                                onChange={() => setReviewMode("daily")}
                              />
                              その日の仕事を先に相談
                            </label>
                            <label className="autonomy-check">
                              <input
                                type="radio"
                                name="autonomy-review-mode"
                                checked={reviewMode === "automatic"}
                                onChange={() => setReviewMode("automatic")}
                              />
                              範囲内で自動的に進める
                            </label>
                          </fieldset>
                          {conflictFor("reviewMode")}
                          <div className="autonomy-numbers">
                            <label className="autonomy-field">
                              確認する間隔（分）
                              <input
                                type="number"
                                min={5}
                                max={1440}
                                required
                                value={intervalMinutes}
                                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                              />
                            </label>
                            <label className="autonomy-field">
                              24時間の実行上限（回）
                              <input
                                type="number"
                                min={1}
                                max={48}
                                required
                                value={maxRunsPerDay}
                                onChange={(event) => setMaxRunsPerDay(Number(event.target.value))}
                              />
                            </label>
                          </div>
                          {conflictFor("intervalMinutes")}
                          {conflictFor("maxRunsPerDay")}
                          {!draftState.synced && (
                            <p className="autonomy-muted" role="status">
                              {draftState.error
                                ? "編集内容をAIに反映できませんでした。"
                                : draftState.conflicts.length > 0
                                  ? "同じ項目の更新を確認してください。"
                                  : "編集内容をAIに反映しています…"}
                            </p>
                          )}
                          {draftState.error && (
                            <div role="alert" className="autonomy-error">
                              <p>{draftState.error}</p>
                              <button type="button" onClick={() => editor.retry()}>
                                反映を再試行
                              </button>
                            </div>
                          )}

                          <details className="autonomy-help">
                            <summary>作業の範囲と実行条件</summary>
                            <p className="autonomy-muted">
                              目的に沿って必要な仕事を選び、実行と検証まで進めます。
                              Gitリポジトリではコミット済みの内容を別の作業場所に複製し、文書やコードの改善・テストを行います。未コミットの変更は含みません。
                              通常のフォルダではテキスト文書を整理・編集します。
                            </p>
                            <p className="autonomy-muted">
                              変更は復元できる形で保存し、作業結果と検証内容を履歴に残します。
                              必要な依存関係や認証がなければ停止して知らせます。
                            </p>
                            <p className="autonomy-muted">
                              Gitリポジトリでの作業にはCodex、通常のフォルダでの文書作業にはClaude
                              Codeへのログインが必要です。
                              Yorishiroを開いている間に動作し、AIの利用枠を消費します。
                              送信・公開・インストールは自動で行いません。
                            </p>
                          </details>
                          <div className="autonomy-save-row">
                            <p id={saveHintId} className="autonomy-muted">
                              「この範囲で任せる」を押すと、設定を保存して自動作業を有効にします。
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
                              {busy === "save" ? "保存しています…" : "この範囲で任せる"}
                            </button>
                          </div>
                        </form>
                      </div>
                    </details>
                    {decidedActions.length > 0 && (
                      <section aria-label="承認履歴">
                        <details className="autonomy-decisions">
                          <summary>
                            承認履歴{" "}
                            <span className="autonomy-count">{decidedActions.length}件</span>
                          </summary>
                          {decidedActions.map((action) => (
                            <AutonomyActionReview
                              key={`${action.id}:${action.payloadDigest}`}
                              action={action}
                              disabled={busy !== null || working || stopping}
                            />
                          ))}
                        </details>
                      </section>
                    )}
                    {status.runs.length > 0 && (
                      <section className="autonomy-history" aria-label="作業履歴">
                        <div className="autonomy-history-heading">
                          <h3>作業履歴</h3>
                          <span className="autonomy-count">{status.runs.length}件</span>
                        </div>
                        {displayedRuns.map((run, index) => (
                          <article key={run.id}>
                            <div className="autonomy-run-meta">
                              <span className={`autonomy-run-badge autonomy-run-${run.status}`}>
                                {RUN_LABELS[run.status]}
                              </span>
                              <time dateTime={new Date(run.startedAt).toISOString()}>
                                {new Date(run.startedAt).toLocaleString("ja-JP")}
                              </time>
                            </div>
                            <p className="autonomy-run-summary">
                              {run.summary
                                ? run.summary.length > 160
                                  ? `${run.summary.slice(0, 160)}…`
                                  : run.summary
                                : "作業を進めています…"}
                            </p>
                            {reviewActions.filter(
                              (action) => action.runId === run.id && action.status === "declined",
                            ).length > 0 && (
                              <p className="autonomy-muted">この作業の確認事項は見送りました。</p>
                            )}
                            {(run.status === "failed" ||
                              (status.phase === "blocked" && index === 0)) && (
                              <button
                                type="button"
                                disabled={busy !== null || working || stopping}
                                onClick={() => {
                                  setSettingsOpen(true);
                                  setTextOpen(true);
                                  void consult(
                                    `おまかせ作業の結果について相談したいです。必要な確認事項と次にできる操作を教えてください。公開や実行の承認ではありません。\n作業ID: ${run.id}\n結果: ${run.summary}\n理由: ${run.reason}`,
                                  );
                                }}
                              >
                                結果についてAIに相談
                              </button>
                            )}
                            {(run.summary.length > 160 ||
                              run.reason ||
                              run.developmentPath ||
                              run.branch ||
                              run.validationSummary ||
                              run.changedPaths.length > 0) && (
                              <details className="autonomy-run-details">
                                <summary>詳細</summary>
                                {run.summary.length > 160 && <p>{run.summary}</p>}
                                {run.reason && <p className="autonomy-muted">{run.reason}</p>}
                                {run.developmentPath && (
                                  <p className="autonomy-path">
                                    確認用の成果物: {run.developmentPath}
                                  </p>
                                )}
                                {run.branch && (
                                  <p className="autonomy-path">ブランチ: {run.branch}</p>
                                )}
                                {run.validationSummary && (
                                  <p className="autonomy-muted">検証: {run.validationSummary}</p>
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
                                    "変更を元に戻しました。",
                                  )
                                }
                              >
                                この作業を元に戻す
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
                            {showAllRuns ? "最新3件を表示" : `すべて表示（${sortedRuns.length}件）`}
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
