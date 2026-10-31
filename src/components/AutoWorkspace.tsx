import { open as choosePath } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Clock3,
  Folder,
  LoaderCircle,
  Mic,
  MicOff,
  Pause,
  Play,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AUTO_WORKSPACE_COPY } from "../i18n/auto-workspace";
import {
  approvePendingWork,
  consultAutonomy,
  declinePendingWork,
  pauseAutonomy,
  runAutonomyNow,
  saveAutonomyContract,
  setAutonomyEnabled,
  undoAutonomyRun,
  updateAutonomyCadence,
  useAutonomyDraftSnapshot,
  useAutonomyStatus,
} from "../runtime/autonomy/client";
import { type DraftField, useAutonomyDraftEditor } from "../runtime/autonomy/draft-editor";
import type { AutonomyContract, AutonomyRun, SetupMessage } from "../runtime/autonomy/types";
import { AutoCadence } from "./AutoCadence";
import { AutonomyActionReview } from "./AutonomyActionReview";
import { resultLink } from "./result-link";
import "./AutoWorkspace.css";

export interface AutoConversation {
  readonly available: boolean;
  readonly state: {
    readonly status: "idle" | "connecting" | "active" | "error";
    readonly microphoneMuted?: boolean;
    readonly error?: string;
  };
  readonly phase?: string;
  readonly latestUtterance?: string;
  readonly onStart: () => Promise<void>;
  readonly onEnd: () => void;
  readonly onSetMuted: (muted: boolean) => void;
}
export interface AutoWorkspaceProps {
  readonly open: boolean;
  readonly language: "ja" | "en";
  readonly cwd: string | null;
  readonly onClose: () => void;
  readonly conversation: AutoConversation;
  readonly onSendMessage?: (text: string) => Promise<string>;
}

const PRESET = {
  workMode: "auto",
  allowedOperations: ["write", "move", "trash"],
  automaticActionApproval: false,
  publishPullRequest: false,
  reviewMode: "automatic",
} as const;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
const localPath = (path?: string) =>
  Boolean(path && !path.includes("\0") && (/^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path)));

/** Host workspace. Subscriptions and in-progress conversations outlive its visibility. */
export function AutoWorkspace({
  open,
  language,
  cwd,
  onClose,
  conversation,
  onSendMessage,
}: AutoWorkspaceProps) {
  const copy = AUTO_WORKSPACE_COPY[language];
  const status = useAutonomyStatus();
  const draft = useAutonomyDraftSnapshot();
  const { editor, state: draftState } = useAutonomyDraftEditor(draft, status?.contract);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<(SetupMessage & { id: number })[]>([]);
  const messageId = useRef(0);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingDraftCadence, setEditingDraftCadence] = useState(false);
  const [history, setHistory] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const composing = useRef(false);
  const seeded = useRef(false);
  const mounted = useRef(true);
  const voiceIntent = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const inputId = useId();
  const goalId = useId();
  const scopeId = useId();
  const titleId = useId();
  const working =
    ["thinking", "applying", "publishing", "executingAction"].includes(status?.phase ?? "") ||
    Boolean(status?.pendingActions?.some((action) => action.status === "executing"));
  const stopping = status?.phase === "stopping";
  const pendingActions = (status?.pendingActions ?? []).filter((action) =>
    ["pending", "approved", "executing"].includes(action.status),
  );
  const executionBusy =
    working || stopping || pendingActions.length > 0 || Boolean(status?.pendingWork);
  const executionBusyRef = useRef(executionBusy);
  executionBusyRef.current = executionBusy;
  const runs = [...(status?.runs ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const selectedRun = selectedRunId ? runs.find((run) => run.id === selectedRunId) : runs[0];
  const showDraft =
    editing || Boolean(draftState.values.goal.trim() && (draft.draft || !status?.contract));
  const callActive = conversation.state.status === "active";
  const callConnecting = conversation.state.status === "connecting";
  const callInProgress = callActive || callConnecting;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) composing.current = false;
  }, [open]);
  useEffect(() => {
    if (!open || !showDraft || history || selectedRunId) setEditingDraftCadence(false);
  }, [open, showDraft, history, selectedRunId]);
  useEffect(() => {
    // Cancel a delayed entry if the view closes or another entry starts a call.
    if (!open || callInProgress) voiceIntent.current += 1;
  }, [open, callInProgress]);
  useEffect(() => {
    if (!open || !status || seeded.current) return;
    seeded.current = true;
    if (!editor.getSnapshot().values.root && cwd) editor.edit("root", cwd);
  }, [open, status, editor, cwd]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [open]);

  async function perform(name: string, operation: () => Promise<void>) {
    if (inFlight.current.has(name)) return;
    inFlight.current.add(name);
    setBusy(new Set(inFlight.current));
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      inFlight.current.delete(name);
      if (mounted.current) setBusy(new Set(inFlight.current));
    }
  }
  async function pickFolder() {
    await perform("folder", async () => {
      const selected = await choosePath({
        directory: true,
        multiple: false,
        title: copy.chooseFolder,
      });
      if (typeof selected === "string" && mounted.current) {
        editor.edit("root", selected);
        setEditing(true);
      }
    });
  }
  function close() {
    voiceIntent.current += 1;
    onClose();
  }
  async function delegate() {
    if (executionBusy || inFlight.current.has("delegate")) return;
    const displayed = editor.getSnapshot().values;
    const assertReviewedGoal = () => {
      const current = editor.getSnapshot();
      if (
        current.values.goal !== displayed.goal ||
        current.values.root !== displayed.root ||
        current.values.intervalMinutes !== displayed.intervalMinutes ||
        current.values.maxRunsPerDay !== displayed.maxRunsPerDay ||
        current.conflicts.length
      )
        throw new Error(copy.latestDraft);
    };
    await perform("delegate", async () => {
      await editor.flush();
      assertReviewedGoal();
      // The visible scope card describes this preset. Normalize only its inactive
      // draft after the explicit delegation click; never mutate a saved contract.
      editor.edit("workMode", PRESET.workMode);
      editor.edit("allowedOperations", [...PRESET.allowedOperations]);
      editor.edit("automaticActionApproval", false);
      editor.edit("publishPullRequest", false);
      editor.edit("reviewMode", PRESET.reviewMode);
      await editor.flush();
      assertReviewedGoal();
      const reviewed = editor.getSnapshot();
      if (!reviewed.synced || reviewed.conflicts.length) throw new Error(copy.latestDraft);
      if (
        executionBusyRef.current ||
        !Object.entries(PRESET).every(
          ([key, value]) =>
            JSON.stringify(reviewed.values[key as DraftField]) === JSON.stringify(value),
        )
      )
        throw new Error(copy.latestDraft);
      if (!reviewed.values.goal.trim() || !reviewed.values.root.trim())
        throw new Error(copy.missingScope);
      const contract: AutonomyContract = {
        ...reviewed.values,
        enabled: true,
      };
      await saveAutonomyContract(contract, reviewed.draftId);
      if (mounted.current) {
        setEditing(false);
        setSelectedRunId(null);
      }
    });
  }
  async function sendMessage() {
    const text = message.trim();
    if (!text || callConnecting || composing.current || inFlight.current.has("consult")) return;
    await perform("consult", async () => {
      await editor.flush();
      const next = [
        ...messages,
        { id: ++messageId.current, role: "user" as const, content: text },
      ].slice(-11);
      const response = onSendMessage
        ? await onSendMessage(text)
        : (
            await consultAutonomy(
              next.map(({ role, content }) => ({ role, content })),
              language,
            )
          ).reply;
      if (!mounted.current) return;
      setMessages(
        response
          ? [...next, { id: ++messageId.current, role: "assistant", content: response }]
          : next,
      );
      setMessage((current) => (current.trim() === text ? "" : current));
    });
  }
  function conflict(field: DraftField) {
    const name =
      field === "goal"
        ? copy.goalField
        : field === "root"
          ? copy.rootField
          : field === "intervalMinutes" || field === "maxRunsPerDay"
            ? copy.frequency
            : copy.scopeField;
    const value = draftState.remoteValues[field];
    return (
      <fieldset className="auto-conflict" key={field}>
        <legend>
          {name} · {copy.conflict}
        </legend>
        {(field === "goal" || field === "root") && <p>{String(value)}</p>}
        <div className="auto-actions">
          <button type="button" onClick={() => editor.resolve(field, "remote")}>
            {copy.remote}
          </button>
          <button type="button" onClick={() => editor.resolve(field, "local")}>
            {copy.local}
          </button>
        </div>
      </fieldset>
    );
  }
  function phaseLabel() {
    if (stopping) return copy.stopping;
    if (working) return copy.working;
    if (
      pendingActions.length ||
      status?.pendingWork ||
      status?.phase === "awaitingReview" ||
      status?.phase === "awaitingAction"
    )
      return copy.pending;
    if (status?.phase === "failed") return copy.failed;
    if (status?.phase === "blocked") return copy.blocked;
    if (status?.phase === "completed" && !status.contract?.enabled) return copy.completed;
    if (!status?.contract?.enabled) return copy.paused;
    if (status.nextRunAt !== null && ["idle", "completed"].includes(status.phase)) {
      if (status.nextRunAt <= Date.now()) return copy.startingSoon;
      const next = new Date(status.nextRunAt);
      const today = next.toDateString() === new Date().toDateString();
      const formatted = next.toLocaleString(language === "ja" ? "ja-JP" : "en-US", {
        ...(today ? {} : { month: "short", day: "numeric" }),
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${status.contract.reviewMode === "daily" ? copy.nextReview : copy.nextRun} ${formatted}`;
    }
    return copy.idle;
  }
  function runLabel(run: AutonomyRun) {
    return {
      running: copy.working,
      completed: copy.completed,
      failed: copy.failed,
      cancelled: copy.cancelled,
      undone: copy.restored,
      proposed: copy.proposed,
    }[run.status];
  }
  function runSummary(run: AutonomyRun) {
    return run.summary.trim() || (run.status === "running" ? copy.working : copy.noSummary);
  }
  function runTime(timestamp: number, label: string, timeOnly = false) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return null;
    const locale = language === "ja" ? "ja-JP" : "en-US";
    const fullDate = date.toLocaleString(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return (
      <>
        <span className="auto-sr-only">{label} </span>
        <time dateTime={date.toISOString()} title={fullDate}>
          {timeOnly
            ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
            : fullDate}
        </time>
      </>
    );
  }
  function renderRun(run: AutonomyRun) {
    const pullRequestUrl = resultLink(run.pullRequestUrl);
    const start = runTime(run.startedAt, copy.started);
    const end =
      run.finishedAt === null
        ? null
        : runTime(
            run.finishedAt,
            copy.finished,
            Boolean(start) &&
              new Date(run.finishedAt).toDateString() === new Date(run.startedAt).toDateString(),
          );
    const decisions = (status?.pendingActions ?? []).filter(
      (action) =>
        action.runId === run.id && !["pending", "approved", "executing"].includes(action.status),
    );
    return (
      <article className="auto-result" aria-label={copy.result}>
        <header>
          <h2>{copy.result}</h2>
          <span>{runLabel(run)}</span>
        </header>
        {(start || end) && (
          <p className="auto-muted">
            {start}
            {start && end && " – "}
            {end}
          </p>
        )}
        <p className="auto-result-summary">{runSummary(run)}</p>
        {run.changedPaths.length > 0 && (
          <section>
            <h3>{copy.changed}</h3>
            <ul className="auto-file-list">
              {run.changedPaths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </section>
        )}
        {run.validationSummary && (
          <section>
            <h3>{copy.validation}</h3>
            <p>{run.validationSummary}</p>
          </section>
        )}
        {run.reason && (
          <details>
            <summary>{copy.evidence}</summary>
            <p>{run.reason}</p>
            {run.branch && <p className="auto-path">{run.branch}</p>}
          </details>
        )}
        <div className="auto-actions">
          {pullRequestUrl && (
            <button
              type="button"
              title={pullRequestUrl}
              disabled={busy.has(`pr:${run.id}`)}
              onClick={() => void perform(`pr:${run.id}`, () => openUrl(pullRequestUrl))}
            >
              {copy.openPullRequest}
            </button>
          )}
          {localPath(run.developmentPath) && (
            <button
              type="button"
              disabled={busy.has(`open:${run.id}`)}
              onClick={() =>
                void perform(`open:${run.id}`, () =>
                  run.developmentPath ? openPath(run.developmentPath) : Promise.resolve(),
                )
              }
            >
              {copy.openResult}
            </button>
          )}
          {run.canUndo && (
            <button
              type="button"
              disabled={working || stopping || busy.has(`undo:${run.id}`)}
              onClick={() => void perform(`undo:${run.id}`, () => undoAutonomyRun(run.id))}
            >
              {copy.undo}
            </button>
          )}
        </div>
        {decisions.map((action) => (
          <AutonomyActionReview
            key={`${action.id}:${action.payloadDigest}`}
            action={action}
            language={language}
            disabled={working || stopping}
          />
        ))}
      </article>
    );
  }

  // Keep polling and the shared draft editor mounted while the workspace is away.
  if (!open) return null;
  return createPortal(
    <>
      <section
        className="auto-workspace"
        ref={panel}
        tabIndex={-1}
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <header className="auto-header">
          <h1 id={titleId}>{copy.title}</h1>
          <button
            type="button"
            className="auto-history-button"
            aria-pressed={history}
            onClick={() => {
              setHistory((current) => !current);
              setSelectedRunId(null);
            }}
          >
            <Clock3 size={15} aria-hidden="true" />
            {copy.history}
          </button>
          <button
            type="button"
            className="auto-icon"
            aria-label={copy.close}
            title={copy.close}
            onClick={close}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="auto-content">
          {(error || status?.error || conversation.state.error) && (
            <p className="auto-error" role="alert">
              {error || status?.error || conversation.state.error}
            </p>
          )}
          {!status ? (
            <p role="status">{copy.loading}</p>
          ) : history ? (
            <section className="auto-history">
              <h2>{copy.history}</h2>
              {runs.length ? (
                runs.map((run) => (
                  <button
                    type="button"
                    className="auto-history-row"
                    key={run.id}
                    onClick={() => {
                      setSelectedRunId(run.id);
                      setHistory(false);
                    }}
                  >
                    <span>
                      <span className="auto-history-summary">{runSummary(run)}</span>
                      <small>{runTime(run.startedAt, copy.started)}</small>
                    </span>
                    <span>{runLabel(run)}</span>
                  </button>
                ))
              ) : (
                <p className="auto-muted">{copy.historyEmpty}</p>
              )}
            </section>
          ) : (
            <>
              {selectedRunId ? (
                <>
                  <button
                    type="button"
                    className="auto-back"
                    onClick={() => setSelectedRunId(null)}
                  >
                    <ArrowLeft size={15} aria-hidden="true" />
                    {copy.current}
                  </button>
                  {selectedRun && renderRun(selectedRun)}
                </>
              ) : (
                <>
                  {!status.contract && !showDraft && (
                    <section className="auto-empty">
                      <button
                        type="button"
                        className="auto-folder"
                        onClick={() => void pickFolder()}
                        title={draftState.values.root || copy.chooseFolder}
                      >
                        <Folder size={15} aria-hidden="true" />
                        {draftState.values.root
                          ? folderName(draftState.values.root)
                          : copy.noFolder}
                      </button>
                      <h2>{copy.current}</h2>
                      <p className="auto-muted">{copy.empty}</p>
                    </section>
                  )}
                  {status.contract && (
                    <section className="auto-current">
                      <div className="auto-current-heading">
                        <div>
                          <p className="auto-eyebrow">{copy.current}</p>
                          <h2>{status.contract.goal}</h2>
                          <p className="auto-path" title={status.contract.root}>
                            <Folder size={14} aria-hidden="true" />
                            {folderName(status.contract.root)}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="auto-text-button"
                          onClick={() => setEditing((current) => !current)}
                          aria-expanded={showDraft}
                        >
                          {copy.revise}
                        </button>
                      </div>
                      {status.contract.automaticActionApproval && (
                        <p className="auto-scope-note">{copy.savedGrant}</p>
                      )}
                      <div className="auto-work-state">
                        <span role="status">{phaseLabel()}</span>
                        <div className="auto-actions">
                          {status.contract.enabled || working || stopping ? (
                            <button
                              type="button"
                              disabled={stopping || busy.has("stop")}
                              onClick={() => void perform("stop", pauseAutonomy)}
                            >
                              <Pause size={14} aria-hidden="true" />
                              {stopping ? copy.stopping : copy.stop}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={executionBusy || busy.has("resume")}
                              onClick={() => void perform("resume", () => setAutonomyEnabled(true))}
                            >
                              <Play size={14} aria-hidden="true" />
                              {copy.resume}
                            </button>
                          )}
                          {["failed", "blocked"].includes(status.phase) && (
                            <button
                              type="button"
                              disabled={executionBusy || busy.size > 0}
                              onClick={() => void perform("retry", runAutonomyNow)}
                            >
                              {copy.retry}
                            </button>
                          )}
                        </div>
                      </div>
                      <AutoCadence
                        value={status.contract}
                        revisionKey={JSON.stringify(status.contract)}
                        language={language}
                        onSave={async ({ intervalMinutes, maxRunsPerDay }) => {
                          if (status.contract)
                            await updateAutonomyCadence(
                              status.contract,
                              intervalMinutes,
                              maxRunsPerDay,
                            );
                        }}
                      />
                    </section>
                  )}
                  {pendingActions.map((action) => (
                    <AutonomyActionReview
                      key={`${action.id}:${action.payloadDigest}`}
                      action={action}
                      language={language}
                      disabled={working || stopping || busy.has("delegate")}
                    />
                  ))}
                  {status.pendingWork && (
                    <article className="auto-request-card">
                      <p className="auto-eyebrow">{copy.upcoming}</p>
                      <h2>{status.pendingWork.goal}</h2>
                      <p>{status.pendingWork.summary}</p>
                      <div className="auto-actions">
                        <button
                          type="button"
                          className="auto-primary"
                          disabled={working || stopping || busy.size > 0}
                          onClick={() => {
                            const id = status.pendingWork?.id;
                            if (id) void perform("work-review", () => approvePendingWork(id));
                          }}
                        >
                          <Check size={15} aria-hidden="true" />
                          {copy.accept}
                        </button>
                        <button
                          type="button"
                          disabled={working || stopping || busy.size > 0}
                          onClick={() => {
                            const id = status.pendingWork?.id;
                            if (id) void perform("work-review", () => declinePendingWork(id));
                          }}
                        >
                          {copy.decline}
                        </button>
                      </div>
                    </article>
                  )}
                  {showDraft && (
                    <section className="auto-draft" aria-label={copy.draft}>
                      <p className="auto-eyebrow">{copy.draft}</p>
                      <button
                        type="button"
                        className="auto-folder"
                        onClick={() => void pickFolder()}
                        disabled={busy.has("delegate") || busy.has("folder")}
                        title={draftState.values.root || copy.chooseFolder}
                      >
                        <Folder size={15} aria-hidden="true" />
                        {draftState.values.root
                          ? folderName(draftState.values.root)
                          : copy.noFolder}
                      </button>
                      <label className="auto-sr-only" htmlFor={goalId}>
                        {copy.request}
                      </label>
                      <textarea
                        id={goalId}
                        value={draftState.values.goal}
                        onChange={(event) => editor.edit("goal", event.target.value)}
                        placeholder={copy.requestPlaceholder}
                        rows={3}
                        maxLength={2000}
                        disabled={busy.has("delegate")}
                      />
                      {draftState.conflicts.map(conflict)}
                      <AutoCadence
                        value={draftState.values}
                        revisionKey={JSON.stringify({
                          ...draftState.values,
                          intervalMinutes: undefined,
                          maxRunsPerDay: undefined,
                        })}
                        optimistic
                        language={language}
                        disabled={busy.has("delegate")}
                        onExpandedChange={setEditingDraftCadence}
                        onSave={async ({ intervalMinutes, maxRunsPerDay }) => {
                          editor.edit("intervalMinutes", intervalMinutes);
                          editor.edit("maxRunsPerDay", maxRunsPerDay);
                          await editor.flush();
                        }}
                      />
                      {draftState.error && !editingDraftCadence && (
                        <div className="auto-error" role="alert">
                          <p>{draftState.error}</p>
                          <button type="button" onClick={() => editor.retry()}>
                            {copy.syncRetry}
                          </button>
                        </div>
                      )}
                      <div className="auto-delegate-row">
                        <p className="auto-scope-note" id={scopeId}>
                          {copy.delegationScope}
                          <br />
                          {copy.externalScope}
                        </p>
                        <button
                          type="button"
                          className="auto-primary"
                          aria-describedby={scopeId}
                          disabled={
                            executionBusy ||
                            editingDraftCadence ||
                            busy.size > 0 ||
                            draftState.conflicts.length > 0 ||
                            !draftState.values.goal.trim() ||
                            !draftState.values.root.trim()
                          }
                          onClick={() => void delegate()}
                        >
                          {status.contract ? copy.replace : copy.delegate}
                        </button>
                      </div>
                    </section>
                  )}
                  {selectedRun && selectedRun.status !== "running" && renderRun(selectedRun)}
                </>
              )}
              {!selectedRunId && (
                <form
                  className="auto-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendMessage();
                  }}
                >
                  <label className="auto-sr-only" htmlFor={inputId}>
                    {copy.message}
                  </label>
                  <textarea
                    id={inputId}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={() => {
                      composing.current = false;
                    }}
                    rows={2}
                    maxLength={4000}
                    placeholder={copy.messagePlaceholder}
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key === "Enter" &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="auto-send"
                    disabled={callConnecting || busy.has("consult") || !message.trim()}
                    aria-label={busy.has("consult") ? copy.sending : copy.send}
                    title={copy.send}
                    aria-busy={busy.has("consult")}
                  >
                    {busy.has("consult") ? (
                      <LoaderCircle size={17} className="auto-spinner" aria-hidden="true" />
                    ) : (
                      <ArrowUp size={18} aria-hidden="true" />
                    )}
                  </button>
                </form>
              )}
              {messages.length > 0 && (
                <details className="auto-conversation-log" open>
                  <summary>{copy.conversationHistory}</summary>
                  <div role="log">
                    {messages.map((item) => (
                      <p key={item.id} className={`auto-message-${item.role}`}>
                        <strong>{item.role === "user" ? copy.you : copy.partner}</strong>
                        {item.content}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </section>
      <section className="auto-conversation-rail" aria-label={copy.voice}>
        {callInProgress && (
          <p role="status" className="auto-call-status">
            {callConnecting
              ? copy.connecting
              : conversation.state.microphoneMuted
                ? copy.muted
                : conversation.phase === "assistant-speaking"
                  ? copy.speaking
                  : conversation.phase === "assistant-responding"
                    ? copy.thinking
                    : copy.listening}
          </p>
        )}
        {conversation.latestUtterance && (
          <p className="auto-utterance" aria-live="polite">
            {conversation.latestUtterance}
          </p>
        )}
        <div className="auto-call-controls">
          {callInProgress ? (
            <>
              <button
                type="button"
                className="auto-icon"
                disabled={!callActive}
                aria-label={conversation.state.microphoneMuted ? copy.unmute : copy.mute}
                aria-pressed={conversation.state.microphoneMuted === true}
                onClick={() => conversation.onSetMuted(!conversation.state.microphoneMuted)}
              >
                {conversation.state.microphoneMuted ? (
                  <MicOff size={18} aria-hidden="true" />
                ) : (
                  <Mic size={18} aria-hidden="true" />
                )}
              </button>
              <button type="button" onClick={conversation.onEnd}>
                {copy.end}
                <X size={15} aria-hidden="true" />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="auto-talk"
              disabled={busy.has("voice")}
              onClick={() =>
                void perform("voice", async () => {
                  const intent = ++voiceIntent.current;
                  await editor.flush();
                  if (!mounted.current || intent !== voiceIntent.current) return;
                  await conversation.onStart();
                })
              }
            >
              <Mic size={17} aria-hidden="true" />
              {copy.talk}
            </button>
          )}
        </div>
      </section>
    </>,
    document.body,
  );
}
