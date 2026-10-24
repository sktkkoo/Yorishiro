import { open as choosePath } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  approvePendingWork,
  consultAutonomy,
  declinePendingWork,
  pauseAutonomy,
  runAutonomyNow,
  saveAutonomyContract,
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

const OPERATIONS: ReadonlyArray<{ id: AutonomyOperation; label: string }> = [
  { id: "write", label: "文章の作成・編集" },
  { id: "move", label: "ファイルの移動" },
  { id: "trash", label: "ファイルの退避" },
];

const PHASE_LABELS = {
  idle: "次の作業を待っています",
  thinking: "目的に沿って次の仕事を考えています",
  applying: "復元できる状態を確保して変更しています",
  paused: "一時停止中",
  failed: "作業を停止しました",
  completed: "今回の作業が終わりました",
  blocked: "続けるための指示を待っています",
  awaitingReview: "今日の仕事について相談しています",
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
const START_CONVERSATION = "おまかせ作業の目的と範囲を一緒に決めたいです。質問から始めてください。";
const DRAFT_LABELS: Record<DraftField, string> = {
  goal: "目的",
  root: "フォルダ",
  allowedOperations: "許可する操作",
  intervalMinutes: "確認する間隔",
  maxRunsPerDay: "実行上限",
  reviewMode: "進め方",
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
  const working = status?.phase === "thinking" || status?.phase === "applying";

  useEffect(() => {
    if (!visible) return;
    panelRef.current?.focus();
    return () => openerRef.current?.focus();
  }, [visible]);

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

  async function consult() {
    const text = message.trim() || START_CONVERSATION;
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
        className="autonomy-launcher"
        aria-haspopup="dialog"
        aria-label="おまかせ作業"
        aria-expanded={visible}
        onClick={openPanel}
      >
        <span
          aria-hidden="true"
          className={working ? "autonomy-dot autonomy-dot-active" : "autonomy-dot"}
        />
        {status?.pendingWork ? "今日の仕事を相談" : "おまかせ作業"}
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
                const controls = panelRef.current?.querySelectorAll<HTMLElement>(
                  "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary",
                );
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
                <h2 id={titleId}>おまかせ作業</h2>
                <button
                  type="button"
                  onClick={() => setVisible(false)}
                  aria-label="おまかせ作業を閉じる"
                >
                  閉じる
                </button>
              </header>
              <p className="autonomy-muted">
                目的と範囲を一緒に決めたら、声をかけなくても作業を進めます。
              </p>
              {status === null ? (
                <p role="status">設定を読み込んでいます…</p>
              ) : (
                <>
                  {status.contract && (
                    <section className="autonomy-status" aria-label="作業状況">
                      <p role="status">{PHASE_LABELS[status.phase]}</p>
                      {status.nextRunAt !== null &&
                        status.contract.enabled &&
                        !status.pendingWork && (
                          <p className="autonomy-muted">
                            次回: {new Date(status.nextRunAt).toLocaleString("ja-JP")}
                          </p>
                        )}
                      <div className="autonomy-actions">
                        <button
                          type="button"
                          disabled={(!status.contract.enabled && !working) || busy === "pause"}
                          onClick={() =>
                            void act("pause", pauseAutonomy, "作業を一時停止しました。")
                          }
                        >
                          一時停止
                        </button>
                        <button
                          type="button"
                          disabled={working || busy !== null || status.pendingWork != null}
                          onClick={() => void act("run", runAutonomyNow)}
                        >
                          今すぐ進める
                        </button>
                      </div>
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
                  <section aria-label="任せる範囲の相談">
                    <h3>話しながら、任せる範囲を決める</h3>
                    <p className="autonomy-muted">
                      やりたいことを話すと、AIが目的やフォルダ、進め方を設定案にまとめます。
                    </p>
                    <p className="autonomy-muted">
                      話した内容がここに反映されます。直接編集した内容もAIに共有されます。
                    </p>
                    <div className="autonomy-conversation-actions">
                      <button
                        className="autonomy-primary"
                        type="button"
                        disabled={busy !== null || voiceStatus?.phase === "starting"}
                        onClick={startVoiceConversation}
                      >
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
                        <div className="autonomy-conversation" role="log" aria-label="相談の履歴">
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
                              enabled: true,
                            },
                            draftState.draftId,
                          ),
                        "この範囲で作業を開始します。範囲はいつでも変更できます。",
                      );
                    }}
                  >
                    <h3>継続して任せる範囲</h3>
                    {explanation && <p className="autonomy-draft-explanation">{explanation}</p>}
                    <p className="autonomy-muted">
                      {status.contract
                        ? "ここでの相談は設定案です。新しい範囲を保存するまでは、現在の設定が使われます。"
                        : "相談中には作業を始めません。下の内容を確認して任せてください。"}
                    </p>
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
                    <label className="autonomy-field">
                      対象フォルダ
                      <input
                        value={root}
                        onChange={(event) => setRoot(event.target.value)}
                        placeholder="会話で決めたフォルダ"
                      />
                    </label>
                    {conflictFor("root")}
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void selectRoot()}
                    >
                      フォルダを選ぶ
                    </button>
                    <fieldset disabled={busy === "save"}>
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
                    {conflictFor("allowedOperations")}
                    <fieldset disabled={busy === "save"}>
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
                    <p className="autonomy-muted" role="status">
                      {draftState.error
                        ? "編集内容をAIに反映できませんでした。"
                        : draftState.conflicts.length > 0
                          ? "同じ項目の更新を確認してください。"
                          : draftState.syncing || !draftState.synced
                            ? "編集内容をAIに反映しています…"
                            : "内容を確認して任せてください。実行は最後の確認後に始まります。"}
                    </p>
                    {draftState.error && (
                      <div role="alert" className="autonomy-error">
                        <p>{draftState.error}</p>
                        <button type="button" onClick={() => editor.retry()}>
                          反映を再試行
                        </button>
                      </div>
                    )}

                    <p className="autonomy-muted">
                      最初はテキスト文書の整理・編集に対応します。変更前の内容を保存し、履歴から元に戻せます。メールなどは下書きまでで、送信は行いません。
                    </p>
                    <p className="autonomy-muted">
                      Claude
                      Codeへのログインが必要です。Yorishiroを開いている間に動作し、AIの利用枠を消費します。
                    </p>
                    <button
                      className="autonomy-primary"
                      type="submit"
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
                  </form>
                  {status.runs.length > 0 && (
                    <section className="autonomy-history" aria-label="作業履歴">
                      <h3>進めた仕事</h3>
                      {status.runs.map((run) => (
                        <article key={run.id}>
                          <p className="autonomy-muted">
                            {new Date(run.startedAt).toLocaleString("ja-JP")} ·{" "}
                            {RUN_LABELS[run.status]}
                          </p>
                          <p>{run.summary || "作業を進めています…"}</p>
                          {run.reason && <p className="autonomy-muted">{run.reason}</p>}
                          {run.changedPaths.length > 0 && (
                            <ul>
                              {run.changedPaths.map((path) => (
                                <li key={path}>{path}</li>
                              ))}
                            </ul>
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
                    </section>
                  )}
                </>
              )}
              {(error || status?.error) && (
                <p className="autonomy-error" role="alert">
                  {error || status?.error}
                </p>
              )}
              {notice && <p role="status">{notice}</p>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
