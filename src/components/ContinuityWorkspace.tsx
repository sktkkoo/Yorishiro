import { ArrowDown, ArrowUp, BookOpen, LoaderCircle, Mic, MicOff, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CONTINUITY_COPY } from "../i18n/continuity";
import {
  actOnContinuityDraft,
  retryContinuity,
  sendContinuityMessage,
  useContinuity,
} from "../runtime/continuity/client";
import type {
  ContinuityContext,
  ContinuityDraft,
  ContinuityMessage,
  ContinuitySnapshot,
  ContinuityUnderstanding,
} from "../runtime/continuity/types";
import "./ContinuityWorkspace.css";

export interface ContinuityConversation {
  readonly available: boolean;
  readonly state: {
    readonly status: "idle" | "connecting" | "active" | "error";
    readonly microphoneMuted?: boolean;
    readonly error?: string;
  };
  readonly phase?: string;
  readonly onStart: () => Promise<void>;
  readonly onEnd: () => void;
  readonly onSetMuted: (muted: boolean) => void;
}
export interface ContinuityWorkspaceProps {
  readonly open: boolean;
  readonly language: "ja" | "en";
  readonly cwd: string | null;
  readonly personaId: string;
  readonly personaName: string;
  readonly personaInstructions: string;
  readonly onClose: () => void;
  readonly conversation?: ContinuityConversation;
}
interface InputDraft {
  readonly text: string;
  readonly correctionId: string | null;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isBuiltInYori = (id: string) => ["yori-ja", "yori-en"].includes(id);
const storagePersona = (id: string) => (isBuiltInYori(id) ? "builtin:yori" : `custom:${id}`);
const inputKey = (id: string) =>
  `yorishiro.continuity.input.${encodeURIComponent(storagePersona(id))}`;
function readInput(id: string): InputDraft {
  try {
    const value = JSON.parse(localStorage.getItem(inputKey(id)) ?? "null");
    if (
      value &&
      typeof value.text === "string" &&
      (value.correctionId === null || typeof value.correctionId === "string")
    )
      return { text: value.text, correctionId: value.correctionId };
  } catch {
    // Unavailable or old browser draft storage does not affect native records.
  }
  return { text: "", correctionId: null };
}
const dateText = (date: number, language: "ja" | "en") =>
  new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));

/** Persona-scoped UI state; native work is independent of this view's visibility. */
export function ContinuityWorkspace(props: ContinuityWorkspaceProps) {
  return <ResidentWorkspace key={storagePersona(props.personaId)} {...props} />;
}

function ResidentWorkspace({
  open,
  language,
  cwd,
  personaId,
  personaName,
  personaInstructions,
  onClose,
  conversation,
}: ContinuityWorkspaceProps) {
  const copy = CONTINUITY_COPY[language];
  const name = isBuiltInYori(personaId) ? "Yori" : personaName;
  const context: ContinuityContext = useMemo(
    () => ({
      personaId,
      personaName: name,
      personaPrompt: personaInstructions,
      language,
      cwd,
    }),
    [personaId, name, personaInstructions, language, cwd],
  );
  const { snapshot, error: syncError } = useContinuity(context);
  const [draft, setDraft] = useState<InputDraft>(() => readInput(personaId));
  const [understandingOpen, setUnderstandingOpen] = useState(false);
  const [detail, setDetail] = useState<
    { kind: "draft"; id: string } | { kind: "source"; ids: readonly string[] } | null
  >(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [voicePending, setVoicePending] = useState(false);
  const [unread, setUnread] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const bookButtonRef = useRef<HTMLButtonElement>(null);
  const bookCloseRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const nearBottom = useRef(true);
  const forceFollow = useRef(false);
  const previouslyVisible = useRef(false);
  const previousMessage = useRef<string | undefined>(undefined);
  const id = useId();
  const titleId = `${id}-title`;
  const bookId = `${id}-understanding`;
  const dialogTitleId = `${id}-detail`;
  const inputId = `${id}-input`;
  const selectedDraft =
    detail?.kind === "draft" ? snapshot?.drafts.find((item) => item.id === detail.id) : null;
  const error = localError ?? syncError ?? snapshot?.error ?? conversation?.state.error;
  const busy = snapshot?.phase === "thinking" || snapshot?.phase === "drafting";
  const callActive = conversation?.state.status === "active";
  const callConnecting = conversation?.state.status === "connecting";
  const correction = draft.correctionId
    ? snapshot?.understandings.find((item) => item.id === draft.correctionId)
    : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(inputKey(personaId), JSON.stringify(draft));
    } catch {
      /* Native conversation is still durable. */
    }
  }, [draft, personaId]);
  useEffect(() => {
    if (open && !previouslyVisible.current) panelRef.current?.focus({ preventScroll: true });
    if (!open) composing.current = false;
    previouslyVisible.current = open;
  }, [open]);
  useEffect(() => {
    if (open && understandingOpen) bookCloseRef.current?.focus({ preventScroll: true });
  }, [understandingOpen, open]);
  useEffect(() => {
    const modal = dialogRef.current;
    if (open && detail && modal && !modal.open) modal.showModal();
  }, [open, detail]);
  const latestMessage = snapshot?.messages[snapshot.messages.length - 1]?.id;
  const latestDraft = snapshot?.drafts
    .map((item) => `${item.id}:${item.updatedAt}:${item.status}`)
    .join("|");
  const latestArrival = `${latestMessage ?? ""}:${latestDraft ?? ""}`;
  useEffect(() => {
    if (!open || !flowRef.current) return;
    const changed = previousMessage.current !== latestArrival;
    previousMessage.current = latestArrival;
    if (nearBottom.current || forceFollow.current) {
      flowRef.current.scrollTop = flowRef.current.scrollHeight;
      forceFollow.current = false;
      nearBottom.current = true;
      setUnread(false);
    } else if (changed) setUnread(true);
  }, [open, latestArrival]);

  async function submit() {
    const text = draft.text.trim();
    if (!text || composing.current || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setLocalError(null);
    const submitted = draft;
    forceFollow.current = true;
    try {
      await sendContinuityMessage(context, text, draft.correctionId ?? undefined);
      if (!mounted.current) return;
      setDraft((current) => (current === submitted ? { text: "", correctionId: null } : current));
      inputRef.current?.focus({ preventScroll: true });
    } catch (cause) {
      forceFollow.current = false;
      if (mounted.current) setLocalError(errorText(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  }
  async function act(draftId: string, action: "continue" | "dismiss") {
    if (actionPending) return;
    setActionPending(true);
    setLocalError(null);
    try {
      await actOnContinuityDraft(context, draftId, action);
      if (action === "continue" && mounted.current) closeDetail();
    } catch (cause) {
      if (mounted.current) setLocalError(errorText(cause));
    } finally {
      if (mounted.current) setActionPending(false);
    }
  }
  async function retry() {
    setLocalError(null);
    try {
      await retryContinuity(context);
    } catch (cause) {
      if (mounted.current) setLocalError(errorText(cause));
    }
  }
  async function startVoice() {
    if (!conversation || voicePending || callConnecting) return;
    setVoicePending(true);
    setLocalError(null);
    try {
      await conversation.onStart();
    } catch (cause) {
      if (mounted.current) setLocalError(errorText(cause));
    } finally {
      if (mounted.current) setVoicePending(false);
    }
  }
  function showDetail(value: NonNullable<typeof detail>) {
    dialogOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetail(value);
  }
  function closeDetail() {
    dialogRef.current?.close();
    setDetail(null);
    dialogOpener.current?.focus({ preventScroll: true });
  }
  function closeUnderstanding() {
    setUnderstandingOpen(false);
    bookButtonRef.current?.focus({ preventScroll: true });
  }
  function correct(entry: ContinuityUnderstanding) {
    setDraft((current) => ({ text: current.text || entry.value, correctionId: entry.id }));
    setUnderstandingOpen(false);
    inputRef.current?.focus({ preventScroll: true });
  }
  function draftCard(item: ContinuityDraft) {
    return (
      <article
        key={item.id}
        className="continuity-draft"
        data-dismissed={item.status === "dismissed"}
      >
        <h3>{item.title}</h3>
        {item.status === "dismissed" ? <small>{copy.dismissed}</small> : null}
        <button
          type="button"
          className="continuity-text-button"
          onClick={() => showDetail({ kind: "draft", id: item.id })}
        >
          {copy.openDraft}
          <ArrowUp size={13} aria-hidden="true" className="continuity-diagonal-arrow" />
        </button>
      </article>
    );
  }
  const draftsByMessage = new Map<string, ContinuityDraft[]>();
  const unanchoredDrafts: ContinuityDraft[] = [];
  const visibleMessages = snapshot?.messages.filter((message) => message.source !== "legacy") ?? [];
  for (const item of snapshot?.drafts ?? []) {
    const anchor = [...visibleMessages]
      .reverse()
      .find((message) => item.sourceIds.includes(message.id));
    if (anchor) draftsByMessage.set(anchor.id, [...(draftsByMessage.get(anchor.id) ?? []), item]);
    else unanchoredDrafts.push(item);
  }

  if (!open) return null;
  return createPortal(
    <section
      className="continuity-workspace"
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-no-window-drag
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          composing.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (detail) closeDetail();
        else if (understandingOpen) closeUnderstanding();
        else onClose();
      }}
    >
      <header className="continuity-header">
        <h1 id={titleId}>
          {name}
          <span className="continuity-sr-only">{copy.conversation}</span>
        </h1>
        <button
          type="button"
          ref={bookButtonRef}
          className="continuity-text-button"
          aria-controls={bookId}
          aria-expanded={understandingOpen}
          onClick={() => setUnderstandingOpen((value) => !value)}
        >
          <BookOpen size={15} aria-hidden="true" />
          {copy.understanding}
        </button>
        <button
          type="button"
          className="continuity-icon"
          aria-label={copy.close}
          title={copy.close}
          onClick={onClose}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="continuity-layout" data-understanding={understandingOpen}>
        <div className="continuity-conversation">
          <div
            className="continuity-flow"
            ref={flowRef}
            onScroll={() => {
              const flow = flowRef.current;
              if (!flow) return;
              nearBottom.current = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 100;
              if (nearBottom.current) setUnread(false);
            }}
          >
            <div
              role="log"
              aria-label={`${name}${copy.conversation}`}
              aria-live="polite"
              aria-relevant="additions text"
              className="continuity-log"
            >
              {visibleMessages.map((message) => (
                <article key={message.id} className="continuity-message" data-role={message.role}>
                  <div className="continuity-message-meta">
                    <strong>{message.role === "user" ? copy.you : name}</strong>
                    <time dateTime={new Date(message.createdAt).toISOString()}>
                      {dateText(message.createdAt, language)}
                    </time>
                  </div>
                  <p>{message.content}</p>
                  {draftsByMessage.get(message.id)?.map(draftCard)}
                </article>
              ))}
            </div>
            {unanchoredDrafts.length > 0 ? (
              <section className="continuity-unanchored-drafts" aria-label={copy.draft}>
                {unanchoredDrafts.map(draftCard)}
              </section>
            ) : null}
            {!snapshot && !error ? (
              <p className="continuity-state" role="status">
                {copy.loading}
              </p>
            ) : null}
            {busy ? (
              <p className="continuity-state" role="status">
                <LoaderCircle size={13} aria-hidden="true" />
                {snapshot.phase === "drafting" ? copy.drafting : copy.thinking}
              </p>
            ) : null}
          </div>
          <div className="continuity-compose-area">
            {error && !detail ? (
              <div className="continuity-error" role="alert">
                <p>{error}</p>
                <button type="button" disabled={busy || sending} onClick={() => void retry()}>
                  {copy.retry}
                </button>
              </div>
            ) : null}
            {unread ? (
              <button
                type="button"
                className="continuity-new-reply"
                onClick={() => {
                  const flow = flowRef.current;
                  if (flow) flow.scrollTop = flow.scrollHeight;
                  nearBottom.current = true;
                  setUnread(false);
                }}
              >
                {copy.latest}
                <ArrowDown size={13} aria-hidden="true" />
              </button>
            ) : null}
            {draft.correctionId ? (
              <div className="continuity-correction">
                <span>
                  {copy.correction}
                  {correction ? ` · ${correction.title}` : ""}
                </span>
                <button
                  type="button"
                  className="continuity-icon"
                  aria-label={copy.cancelCorrection}
                  onClick={() => setDraft((current) => ({ ...current, correctionId: null }))}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <form
              className="continuity-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="continuity-sr-only" htmlFor={inputId}>
                {name}
                {copy.message}
              </label>
              <textarea
                id={inputId}
                ref={inputRef}
                value={draft.text}
                rows={2}
                placeholder={`${name}${copy.message}`}
                onChange={(event) => {
                  const text = event.currentTarget.value;
                  setDraft((current) => ({ ...current, text }));
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !composing.current &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="continuity-composer-actions">
                {conversation?.available ? (
                  callActive ? (
                    <>
                      <button
                        type="button"
                        className="continuity-icon"
                        aria-label={conversation.state.microphoneMuted ? copy.unmute : copy.mute}
                        title={conversation.state.microphoneMuted ? copy.unmute : copy.mute}
                        onClick={() => conversation.onSetMuted(!conversation.state.microphoneMuted)}
                      >
                        {conversation.state.microphoneMuted ? (
                          <MicOff size={16} aria-hidden="true" />
                        ) : (
                          <Mic size={16} aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="continuity-text-button"
                        onClick={conversation.onEnd}
                      >
                        {copy.end}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="continuity-icon"
                      disabled={callConnecting || voicePending}
                      aria-label={callConnecting || voicePending ? copy.connecting : copy.talk}
                      title={callConnecting || voicePending ? copy.connecting : copy.talk}
                      onClick={() => void startVoice()}
                    >
                      {callConnecting || voicePending ? (
                        <LoaderCircle size={16} aria-hidden="true" />
                      ) : (
                        <Mic size={16} aria-hidden="true" />
                      )}
                    </button>
                  )
                ) : null}
                <button
                  className="continuity-send"
                  type="submit"
                  disabled={!draft.text.trim() || sending}
                  aria-label={copy.send}
                  title={copy.send}
                >
                  <ArrowUp size={17} aria-hidden="true" />
                </button>
              </div>
            </form>
          </div>
        </div>
        <aside
          id={bookId}
          className="continuity-understanding"
          hidden={!understandingOpen}
          aria-labelledby={`${bookId}-title`}
        >
          <header>
            <h2 id={`${bookId}-title`}>{copy.understanding}</h2>
            <button
              type="button"
              ref={bookCloseRef}
              className="continuity-icon"
              aria-label={copy.closeUnderstanding}
              onClick={closeUnderstanding}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          {!snapshot?.understandings.length ? (
            <p className="continuity-muted">{copy.emptyUnderstanding}</p>
          ) : (
            snapshot.understandings.map((entry) => (
              <article className="continuity-understanding-entry" key={entry.id}>
                <h3>{entry.title}</h3>
                <p>{entry.value}</p>
                {entry.certainty !== "confirmed" ? (
                  <small>{entry.certainty === "inferred" ? copy.inferred : copy.unverified}</small>
                ) : null}
                <UnderstandingHistory
                  entry={entry}
                  snapshot={snapshot}
                  language={language}
                  onSource={(ids) => showDetail({ kind: "source", ids })}
                />
                <button
                  type="button"
                  className="continuity-text-button"
                  onClick={() => correct(entry)}
                >
                  {copy.correct}
                </button>
              </article>
            ))
          )}
        </aside>
      </div>
      {detail ? (
        <dialog
          className="continuity-detail"
          ref={dialogRef}
          aria-labelledby={dialogTitleId}
          onCancel={(event) => {
            event.preventDefault();
            closeDetail();
          }}
        >
          <header>
            <h2 id={dialogTitleId}>{selectedDraft?.title ?? copy.source}</h2>
            <button
              type="button"
              className="continuity-icon"
              aria-label={copy.closeDetail}
              onClick={closeDetail}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </header>
          {error ? (
            <p className="continuity-error" role="alert">
              {error}
            </p>
          ) : null}
          {selectedDraft ? (
            <>
              <div className="continuity-draft-body">{selectedDraft.content}</div>
              {selectedDraft.reason ? (
                <details>
                  <summary>{copy.reason}</summary>
                  <p>{selectedDraft.reason}</p>
                  <SourceMessages
                    sourceIds={selectedDraft.sourceIds}
                    messages={snapshot?.messages ?? []}
                    language={language}
                  />
                </details>
              ) : null}
              {selectedDraft.status === "ready" ? (
                <div className="continuity-detail-actions">
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => void act(selectedDraft.id, "continue")}
                  >
                    {copy.continueDraft}
                  </button>
                  <button
                    type="button"
                    className="continuity-text-button"
                    disabled={actionPending}
                    onClick={() => void act(selectedDraft.id, "dismiss")}
                  >
                    {copy.dismissDraft}
                  </button>
                </div>
              ) : (
                <p className="continuity-muted">{copy.dismissed}</p>
              )}
            </>
          ) : detail.kind === "source" ? (
            <SourceMessages
              sourceIds={detail.ids}
              messages={snapshot?.messages ?? []}
              language={language}
            />
          ) : null}
        </dialog>
      ) : null}
    </section>,
    document.body,
  );
}

function SourceMessages({
  sourceIds,
  messages,
  language,
}: {
  sourceIds: readonly string[];
  messages: readonly ContinuityMessage[];
  language: "ja" | "en";
}) {
  const sources = messages.filter((message) => sourceIds.includes(message.id));
  return (
    <>
      {sources.length ? (
        sources.map((source) => (
          <blockquote key={source.id}>
            <small>{dateText(source.createdAt, language)}</small>
            <p>{source.content}</p>
          </blockquote>
        ))
      ) : (
        <p className="continuity-muted">{CONTINUITY_COPY[language].missingSource}</p>
      )}
    </>
  );
}
function UnderstandingHistory({
  entry,
  snapshot,
  language,
  onSource,
}: {
  entry: ContinuityUnderstanding;
  snapshot: ContinuitySnapshot;
  language: "ja" | "en";
  onSource: (ids: readonly string[]) => void;
}) {
  const copy = CONTINUITY_COPY[language];
  const related = snapshot.reflections.filter(
    (reflection) =>
      reflection.understandingIds.includes(entry.id) &&
      reflection.sourceIds.some((id) => entry.sourceIds.includes(id)),
  );
  const history = [
    {
      value: entry.value,
      reason: related.map((reflection) => reflection.content).join("\n"),
      sourceIds: entry.sourceIds,
      createdAt: entry.updatedAt,
    },
    ...[...entry.revisions].reverse(),
  ];
  return (
    <details className="continuity-understanding-history">
      <summary>{copy.history}</summary>
      <ol>
        {history.map((item, index) => (
          <li key={`${item.createdAt}:${item.sourceIds.join("|")}:${item.value}`}>
            <small>{dateText(item.createdAt, language)}</small>
            {index > 0 ? (
              <p>
                <span className="continuity-history-label">{copy.previous}</span>
                {item.value}
              </p>
            ) : null}
            {item.reason ? <p>{item.reason}</p> : null}
            <SourceMessages
              sourceIds={item.sourceIds}
              messages={snapshot.messages}
              language={language}
            />
            {item.sourceIds.some((id) => snapshot.messages.some((message) => message.id === id)) ? (
              <button
                type="button"
                className="continuity-text-button"
                onClick={() => onSource(item.sourceIds)}
              >
                {copy.source}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
