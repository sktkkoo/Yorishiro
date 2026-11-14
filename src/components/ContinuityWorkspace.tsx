import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  LoaderCircle,
  Mic,
  MicOff,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CONTINUITY_COPY } from "../i18n/continuity";
import {
  actOnContinuityDraft,
  type ContinuityErrorSource,
  forgetContinuityUnderstanding,
  refreshContinuity,
  retryContinuity,
  setContinuityAutoEnabled,
  useContinuity,
} from "../runtime/continuity/client";
import { piDiagnosticMessages, usePiDiagnostics } from "../runtime/continuity/pi-diagnostics";
import type {
  ContinuityContext,
  ContinuityDraft,
  ContinuityMessage,
  ContinuitySnapshot,
  ContinuityUnderstanding,
} from "../runtime/continuity/types";
import "./ContinuityWorkspace.css";
import { continuityComposerIdentity, useContinuityComposer } from "./continuity-composer";
import {
  activeContinuityInput,
  cancelCorrection,
  editContinuityInput,
  forgetCorrection,
  selectCorrection,
} from "./continuity-input";
import {
  acknowledgeReplyArrival,
  clearReplyArrivals,
  createReplyArrivals,
  reconcileReplyArrivals,
} from "./continuity-reply-arrivals";
import { useDraftArrivals } from "./draft-arrivals";
import { PiSetup } from "./PiSetup";
import { ResultText } from "./ResultText";

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
  readonly executionBackend?: ContinuityContext["executionBackend"];
  readonly executionSessionId?: string | null;
  readonly onClose: () => void;
  readonly conversation?: ContinuityConversation;
}
interface WorkspaceError {
  readonly message: string;
  readonly source: ContinuityErrorSource | "voice";
}
interface ReadingPosition {
  readonly key: string | null;
  readonly offset: number;
  readonly scrollTop: number;
}
function captureReadingPosition(flow: HTMLDivElement): ReadingPosition {
  const viewport = flow.getBoundingClientRect();
  const visible = Array.from(flow.querySelectorAll<HTMLElement>("[data-reading-key]")).filter(
    (element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    },
  );
  const first = visible[0];
  // 読書位置の上端にある草案を優先し、下端に少し見える草案へは基準を移さない。
  const anchor =
    visible.find(
      (element) =>
        element !== first &&
        first?.contains(element) &&
        element.getBoundingClientRect().top <= viewport.top,
    ) ?? first;
  return {
    key: anchor?.dataset.readingKey ?? null,
    offset: anchor ? anchor.getBoundingClientRect().top - viewport.top : 0,
    scrollTop: flow.scrollTop,
  };
}
function restoreReadingPosition(flow: HTMLDivElement, position: ReadingPosition) {
  const anchor = Array.from(flow.querySelectorAll<HTMLElement>("[data-reading-key]")).find(
    (element) => element.dataset.readingKey === position.key,
  );
  const top = anchor
    ? flow.scrollTop +
      anchor.getBoundingClientRect().top -
      flow.getBoundingClientRect().top -
      position.offset
    : position.scrollTop;
  flow.scrollTop = Math.min(Math.max(0, top), Math.max(0, flow.scrollHeight - flow.clientHeight));
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isBuiltInYori = (id: string) => ["yori-ja", "yori-en"].includes(id);
const dateText = (date: number, language: "ja" | "en") =>
  new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));

function automaticRecheckTime(snapshot: ContinuitySnapshot | null, language: "ja" | "en") {
  const timestamp = snapshot?.automaticRetryAt;
  if (
    snapshot?.phase !== "error" ||
    snapshot.autoEnabled !== true ||
    !snapshot.error ||
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0
  )
    return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  // 時刻を過ぎても次のホスト確認を待つ場合があるため、開始時刻や残り秒数とは扱わない。
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(
      date,
    ),
  };
}

function latestPendingReply(messages: readonly ContinuityMessage[]): ContinuityMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.source === "legacy") continue;
    if (message.role === "user") break;
    if (message.role === "assistant" && message.replyKind === "awaitingReply") return message;
  }
  return null;
}

/** Persona-scoped UI state; native work is independent of this view's visibility. */
export function ContinuityWorkspace(props: ContinuityWorkspaceProps) {
  return <ResidentWorkspace key={continuityComposerIdentity(props.personaId)} {...props} />;
}

function ResidentWorkspace({
  open,
  language,
  cwd,
  personaId,
  personaName,
  personaInstructions,
  executionBackend,
  executionSessionId,
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
      ...(executionSessionId !== undefined ? { executionSessionId } : {}),
      ...(executionBackend !== undefined ? { executionBackend } : {}),
    }),
    [personaId, name, personaInstructions, language, cwd, executionBackend, executionSessionId],
  );
  const { snapshot, error: syncError, errorSource: syncErrorSource } = useContinuity(context, open);
  const draftArrivals = useDraftArrivals(personaId, snapshot?.drafts ?? null);
  const piDiagnostics = usePiDiagnostics(cwd, open, executionBackend);
  const [piReadiness, setPiReadiness] = useState({ cwd, ready: executionBackend !== "pi" });
  const onPiReadiness = useCallback((ready: boolean) => setPiReadiness({ cwd, ready }), [cwd]);
  const piReady = executionBackend !== "pi" || (piReadiness.cwd === cwd && piReadiness.ready);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const settingsScope = useRef({ cwd, personaId, executionBackend });
  const [piAttention, setPiAttention] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettings = () => {
    if (!settingsOpenRef.current) return;
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  };
  useEffect(() => {
    const previous = settingsScope.current;
    if (
      previous.cwd === cwd &&
      previous.personaId === personaId &&
      previous.executionBackend === executionBackend
    )
      return;
    settingsScope.current = { cwd, personaId, executionBackend };
    if (settingsOpenRef.current) settingsButtonRef.current?.focus();
    setSettingsOpen(false);
  }, [cwd, personaId, executionBackend]);
  const composer = useContinuityComposer(personaId, open);
  const { input: inputDrafts, updateInput: setInputDrafts, sending } = composer;
  const draft = {
    text: activeContinuityInput(inputDrafts).text,
    correctionId: inputDrafts.target.id,
  };
  const [understandingOpen, setUnderstandingOpen] = useState(false);
  const [detail, setDetail] = useState<
    | { kind: "draft"; id: string }
    | { kind: "source"; ids: readonly string[] }
    | { kind: "forget"; entry: ContinuityUnderstanding }
    | null
  >(null);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const [localError, setLocalError] = useState<WorkspaceError | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [voicePending, setVoicePending] = useState(false);
  const [autoPending, setAutoPending] = useState(false);
  const [forgetPending, setForgetPending] = useState(false);
  const [retryPending, setRetryPending] = useState<"work" | "sync" | null>(null);
  const retryInFlight = useRef(false);
  const forgetInFlight = useRef(false);
  const autoInFlight = useRef(false);
  const voiceInFlight = useRef(false);
  const voiceAttempt = useRef(0);
  const replyArrivals = useRef(createReplyArrivals());
  const [unreadIds, setUnreadIds] = useState<readonly string[]>([]);
  const unread = unreadIds.length > 0;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const readingPosition = useRef<ReadingPosition | null>(null);
  const flowNeedsRestore = useRef(false);
  const restoredScrollTop = useRef<number | null>(null);
  const [messageNavigation, setMessageNavigation] = useState<{ id: string } | null>(null);
  const appliedMessageNavigation = useRef(messageNavigation);
  const attachFlow = useCallback((flow: HTMLDivElement | null) => {
    if (!flow) return;
    flowRef.current = flow;
    flowNeedsRestore.current = true;
    // ref の解放時は DOM がまだ接続されており、非表示になる直前の位置を測れる。
    return () => {
      readingPosition.current = captureReadingPosition(flow);
      flowRef.current = null;
      restoredScrollTop.current = null;
    };
  }, []);
  const readingMessageId = useRef<string | null>(null);
  const readingMessageKind = useRef<"question" | "arrival" | null>(null);
  const bookButtonRef = useRef<HTMLButtonElement>(null);
  const bookCloseRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const forgetCancelRef = useRef<HTMLButtonElement>(null);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const mounted = useRef(true);
  const nearBottom = useRef(true);
  const forceFollow = useRef(false);
  const previouslyVisible = useRef(false);
  const previousMessage = useRef<string | undefined>(undefined);
  const previousDraftLayout = useRef<string | undefined>(undefined);
  const id = useId();
  const titleId = `${id}-title`;
  const settingsId = `${id}-settings`;
  const settingsHintId = `${id}-settings-hint`;
  const bookId = `${id}-understanding`;
  const dialogTitleId = `${id}-detail`;
  const inputId = `${id}-input`;
  const autoDescriptionId = `${id}-autonomy-description`;
  const pendingReplyId = `${id}-pending-reply`;
  const pendingReply = latestPendingReply(snapshot?.messages ?? []);
  const selectedDraft =
    detail?.kind === "draft" ? snapshot?.drafts.find((item) => item.id === detail.id) : null;
  const selectedForget =
    detail?.kind === "forget"
      ? snapshot?.understandings.find((item) => item.id === detail.entry.id)
      : null;
  const workFailure: WorkspaceError | null =
    syncError && syncErrorSource === "work"
      ? { message: syncError, source: "work" }
      : snapshot?.error
        ? { message: snapshot.error, source: "work" }
        : null;
  const automaticRecheck = automaticRecheckTime(snapshot, language);
  const operationError: WorkspaceError | null =
    localError ??
    (composer.error ? { message: composer.error, source: "send" } : null) ??
    (syncError && syncErrorSource !== "work"
      ? { message: syncError, source: syncErrorSource ?? "sync" }
      : conversation?.state.error
        ? { message: conversation.state.error, source: "voice" }
        : null);
  const presentedError = operationError ?? workFailure;
  const error = presentedError?.message;
  const additionalVoiceError =
    presentedError?.source !== "voice" ? conversation?.state.error : null;
  const recoveryHint =
    presentedError && presentedError.source !== "work"
      ? copy.recovery[presentedError.source]
      : null;
  const busy =
    snapshot?.phase === "thinking" ||
    snapshot?.phase === "drafting" ||
    snapshot?.phase === "working";
  const activity =
    snapshot?.phase === "working"
      ? copy.working
      : snapshot?.phase === "drafting"
        ? copy.drafting
        : snapshot?.phase === "thinking"
          ? copy.thinking
          : !snapshot && !error
            ? copy.loading
            : snapshot?.phase === "idle" &&
                snapshot.autoEnabled === true &&
                !syncError &&
                !snapshot.error &&
                piReady
              ? copy.idle
              : null;
  const autoDescription =
    snapshot?.autoEnabled === true
      ? copy.autonomyOn
      : snapshot?.autoEnabled === false
        ? busy
          ? copy.autonomyFinishing
          : null
        : copy.loading;
  const callActive = conversation?.state.status === "active";
  const callConnecting = conversation?.state.status === "connecting";
  const correction = draft.correctionId
    ? snapshot?.understandings.find((item) => item.id === draft.correctionId)
    : null;
  const showVoiceError = Boolean(additionalVoiceError && !detail);
  const feedbackErrors = detail
    ? []
    : [operationError, executionBackend !== "pi" || piReady ? workFailure : null].filter(
        (failure): failure is WorkspaceError => failure !== null,
      );
  const hasFeedback = Boolean(
    activity ||
      pendingReply ||
      draftArrivals.pending.length ||
      showVoiceError ||
      feedbackErrors.length ||
      unread ||
      draft.correctionId,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    if (open && detail && modal && !modal.open) {
      modal.showModal();
      if (detail.kind === "forget") forgetCancelRef.current?.focus({ preventScroll: true });
    }
  }, [open, detail]);
  useEffect(() => {
    if (
      !open ||
      detail?.kind !== "forget" ||
      !snapshot ||
      snapshot.understandings.some((item) => item.id === detail.entry.id) ||
      forgetPending
    )
      return;
    dialogRef.current?.close();
    setDetail(null);
    setInputDrafts((current) => forgetCorrection(current, detail.entry.id));
    bookCloseRef.current?.focus({ preventScroll: true });
  }, [open, detail, snapshot, forgetPending, setInputDrafts]);
  const latestMessage = snapshot?.messages[snapshot.messages.length - 1]?.id;
  const draftLayout = useMemo(
    () =>
      JSON.stringify(
        snapshot?.drafts.map((item) => [
          item.id,
          item.title,
          item.content,
          item.status,
          [...item.sourceIds].sort(),
        ]),
      ),
    [snapshot?.drafts],
  );
  useLayoutEffect(() => {
    const messages = snapshot?.messages;
    if (messages) {
      if (
        readingMessageId.current &&
        !messages.some(
          (message) => message.id === readingMessageId.current && message.source !== "legacy",
        )
      ) {
        readingMessageId.current = null;
        readingMessageKind.current = null;
      }
      // 非表示でも履歴の追加・削除を追跡し、読書中の先頭の新着を後続の報告で失わない。
      replyArrivals.current = reconcileReplyArrivals(
        replyArrivals.current,
        messages,
        (nearBottom.current && !readingMessageId.current) || forceFollow.current,
      );
      setUnreadIds(replyArrivals.current.pending);
    }
    if (!open || !flowRef.current) return;
    const flow = flowRef.current;
    const changed = previousMessage.current !== (latestMessage ?? "");
    const draftChanged = previousDraftLayout.current !== draftLayout;
    previousMessage.current = latestMessage ?? "";
    previousDraftLayout.current = draftLayout;
    const navigationId =
      messageNavigation !== appliedMessageNavigation.current ? messageNavigation?.id : null;
    appliedMessageNavigation.current = messageNavigation;
    const target = navigationId
      ? Array.from(flow.querySelectorAll<HTMLElement>(".continuity-message")).find(
          (message) => message.dataset.readingKey === `message:${navigationId}`,
        )
      : null;
    if (target) {
      // 新着ボタンの消失で高さが変わった後の座標を使い、末尾への自動 clamp も保護する。
      flow.scrollTop = Math.min(
        Math.max(0, flow.scrollHeight - flow.clientHeight),
        Math.max(
          0,
          flow.scrollTop +
            target.getBoundingClientRect().top -
            flow.getBoundingClientRect().top -
            8,
        ),
      );
      restoredScrollTop.current = flow.scrollTop;
    } else if (!forceFollow.current && !changed && draftChanged && readingPosition.current) {
      restoreReadingPosition(flow, readingPosition.current);
      restoredScrollTop.current = flow.scrollTop;
    } else if ((nearBottom.current && !readingMessageId.current) || forceFollow.current) {
      flow.scrollTop = flow.scrollHeight;
      forceFollow.current = false;
      nearBottom.current = true;
    } else if (flowNeedsRestore.current && readingPosition.current) {
      restoreReadingPosition(flow, readingPosition.current);
      restoredScrollTop.current = flow.scrollTop;
    }
    flowNeedsRestore.current = false;
    readingPosition.current = captureReadingPosition(flow);
  }, [open, latestMessage, snapshot?.messages, draftLayout, messageNavigation]);

  function clearUnreadReplies() {
    replyArrivals.current = clearReplyArrivals(replyArrivals.current);
    setUnreadIds(replyArrivals.current.pending);
  }

  function showUnreadMessage(messageId: string, kind: "question" | "arrival" = "arrival") {
    const flow = flowRef.current;
    const message = flow
      ? Array.from(flow.querySelectorAll<HTMLElement>(".continuity-message")).find(
          (item) => item.dataset.readingKey === `message:${messageId}`,
        )
      : null;
    if (!message || !flow) return;
    readingMessageId.current = messageId;
    readingMessageKind.current = kind;
    nearBottom.current = false;
    forceFollow.current = false;
    message.focus({ preventScroll: true });
    setMessageNavigation({ id: messageId });
    replyArrivals.current = acknowledgeReplyArrival(replyArrivals.current, messageId);
    setUnreadIds(replyArrivals.current.pending);
  }

  function showPendingReply() {
    if (pendingReply) showUnreadMessage(pendingReply.id, "question");
  }

  async function submit() {
    if (executionBackend === "pi" && !piReady) return;
    if (composing.current) return;
    const completion = composer.send(context);
    if (!completion) return;
    setLocalError(null);
    readingMessageId.current = null;
    readingMessageKind.current = null;
    forceFollow.current = true;
    inputRef.current?.focus({ preventScroll: true });
    try {
      await completion;
    } catch {
      forceFollow.current = false;
    }
  }
  function clearLocalError() {
    setLocalError(null);
    composer.clearError();
  }
  async function act(draftId: string, action: "continue" | "dismiss") {
    if (action === "continue" && executionBackend === "pi" && !piReady) return;
    if (actionPending) return;
    setActionPending(true);
    clearLocalError();
    const submittedDetail = detail;
    const submittedDialog = dialogRef.current;
    try {
      await actOnContinuityDraft(context, draftId, action);
      // 同じ草案でも、閉じ直しや画面の再表示後は別の閲覧として扱う。
      if (
        action === "continue" &&
        mounted.current &&
        detailRef.current === submittedDetail &&
        dialogRef.current === submittedDialog &&
        submittedDialog?.open
      )
        closeDetail();
    } catch (cause) {
      if (mounted.current) setLocalError({ message: errorText(cause), source: "draft" });
    } finally {
      if (mounted.current) setActionPending(false);
    }
  }
  async function retry(source: "work" | "sync" = "work") {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetryPending(source);
    try {
      if (source === "sync") await refreshContinuity(context);
      else await retryContinuity(context);
    } catch {
      // 復旧失敗は共有クライアントが保持し、後続の受理済み状態で更新する。
    } finally {
      retryInFlight.current = false;
      if (mounted.current) setRetryPending(null);
    }
  }
  async function forget(entry: ContinuityUnderstanding) {
    if (forgetInFlight.current) return;
    forgetInFlight.current = true;
    setForgetPending(true);
    clearLocalError();
    try {
      await forgetContinuityUnderstanding(context, entry.id);
      if (!mounted.current) return;
      setInputDrafts((current) => forgetCorrection(current, entry.id));
      closeDetail(true);
    } catch (cause) {
      if (mounted.current) setLocalError({ message: errorText(cause), source: "forget" });
    } finally {
      forgetInFlight.current = false;
      if (mounted.current) setForgetPending(false);
    }
  }
  async function toggleAutonomy() {
    if (autoInFlight.current || typeof snapshot?.autoEnabled !== "boolean") return;
    autoInFlight.current = true;
    setAutoPending(true);
    clearLocalError();
    try {
      await setContinuityAutoEnabled(context, !snapshot.autoEnabled);
    } catch (cause) {
      if (mounted.current) setLocalError({ message: errorText(cause), source: "autonomy" });
    } finally {
      autoInFlight.current = false;
      if (mounted.current) setAutoPending(false);
    }
  }
  async function startVoice() {
    if (!conversation || voiceInFlight.current || callConnecting || callActive) return;
    const attempt = ++voiceAttempt.current;
    voiceInFlight.current = true;
    setVoicePending(true);
    setLocalError((current) => (current?.source === "voice" ? null : current));
    try {
      await conversation.onStart();
    } catch (cause) {
      if (mounted.current && voiceAttempt.current === attempt)
        setLocalError({ message: errorText(cause), source: "voice" });
    } finally {
      if (voiceAttempt.current === attempt) {
        voiceInFlight.current = false;
        if (mounted.current) setVoicePending(false);
      }
    }
  }
  function endVoice() {
    // 取り消した開始要求の完了は、新しい接続操作の状態を書き換えない。
    ++voiceAttempt.current;
    voiceInFlight.current = false;
    setVoicePending(false);
    setLocalError((current) => (current?.source === "voice" ? null : current));
    conversation?.onEnd();
  }
  function showDetail(value: NonNullable<typeof detail>) {
    clearLocalError();
    dialogOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetail(value);
  }
  function openDraft(item: { id: string; content: string }, fromCue = false) {
    showDetail({ kind: "draft", id: item.id });
    // 確認済みの通知は消えるので、閉じるときは安定した入力欄へ戻す。
    if (fromCue) dialogOpener.current = inputRef.current;
    draftArrivals.acknowledge(item.id, item.content);
  }
  function closeDetail(forgotten = false) {
    if (forgetInFlight.current && !forgotten) return;
    dialogRef.current?.close();
    setDetail(null);
    if (forgotten || !dialogOpener.current?.isConnected) {
      bookCloseRef.current?.focus({ preventScroll: true });
    } else dialogOpener.current.focus({ preventScroll: true });
  }
  function closeUnderstanding() {
    setUnderstandingOpen(false);
    bookButtonRef.current?.focus({ preventScroll: true });
  }
  function correct(entry: ContinuityUnderstanding) {
    setInputDrafts((current) => selectCorrection(current, entry.id, entry.value));
    setUnderstandingOpen(false);
    inputRef.current?.focus({ preventScroll: true });
  }
  function draftCard(item: ContinuityDraft) {
    return (
      <article
        key={item.id}
        className="continuity-draft"
        data-reading-key={`draft:${item.id}`}
        data-dismissed={item.status === "dismissed"}
      >
        <h3>{item.title}</h3>
        {item.status === "dismissed" ? <small>{copy.dismissed}</small> : null}
        <button type="button" className="continuity-text-button" onClick={() => openDraft(item)}>
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
        else if (settingsOpen) closeSettings();
        else if (understandingOpen) closeUnderstanding();
        else onClose();
      }}
    >
      <header className="continuity-header">
        <div className="continuity-autonomy">
          <div className="continuity-autonomy-control">
            <h1 id={titleId}>{copy.autonomy}</h1>
            <button
              type="button"
              role="switch"
              className="continuity-autonomy-switch"
              aria-label={copy.autonomy}
              aria-checked={snapshot?.autoEnabled === true}
              aria-describedby={autoDescription ? autoDescriptionId : undefined}
              aria-busy={autoPending || undefined}
              disabled={autoPending || typeof snapshot?.autoEnabled !== "boolean"}
              onClick={() => void toggleAutonomy()}
            >
              <span className="continuity-switch-track" aria-hidden="true">
                <span />
              </span>
              {typeof snapshot?.autoEnabled === "boolean"
                ? snapshot.autoEnabled
                  ? "On"
                  : "Off"
                : copy.loading}
            </button>
          </div>
          {autoDescription ? <p id={autoDescriptionId}>{autoDescription}</p> : null}
        </div>
        <div className="continuity-header-actions">
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
          {executionBackend === "pi" ? (
            <div className="continuity-settings-control">
              <button
                type="button"
                ref={settingsButtonRef}
                className="continuity-text-button"
                aria-controls={settingsId}
                aria-expanded={settingsOpen}
                aria-describedby={piAttention ? settingsHintId : undefined}
                onClick={() => (settingsOpen ? closeSettings() : setSettingsOpen(true))}
              >
                <Settings size={15} aria-hidden="true" />
                {copy.settings}
              </button>
              {piAttention ? <span id={settingsHintId}>{copy.settingsAttention}</span> : null}
            </div>
          ) : null}
        </div>
      </header>
      <div className="continuity-layout" data-understanding={understandingOpen}>
        <div className="continuity-conversation">
          {executionBackend === "pi" ? (
            <PiSetup
              key={cwd}
              open={settingsOpen}
              panelId={settingsId}
              onClose={closeSettings}
              onAttentionChange={setPiAttention}
              cwd={cwd}
              language={language}
              onReadinessChange={onPiReadiness}
              onConfigured={() => {
                if (snapshot?.autoEnabled === true) void retry();
              }}
            />
          ) : null}
          <div
            className="continuity-flow"
            ref={attachFlow}
            onScroll={() => {
              const flow = flowRef.current;
              if (!flow) return;
              readingPosition.current = captureReadingPosition(flow);
              const restored = restoredScrollTop.current;
              if (restored === flow.scrollTop) return;
              restoredScrollTop.current = null;
              nearBottom.current = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 100;
              if (nearBottom.current && readingMessageKind.current === "arrival") {
                readingMessageId.current = null;
                readingMessageKind.current = null;
              }
              if (nearBottom.current && !readingMessageId.current) clearUnreadReplies();
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
                <article
                  key={message.id}
                  className="continuity-message"
                  data-reading-key={`message:${message.id}`}
                  data-role={message.role}
                  id={message.id === pendingReply?.id ? pendingReplyId : undefined}
                  tabIndex={message.role === "assistant" ? -1 : undefined}
                  aria-label={message.id === pendingReply?.id ? copy.replyRequested : undefined}
                  onBlur={(event) => {
                    if (
                      readingMessageId.current === message.id &&
                      !event.currentTarget.contains(event.relatedTarget)
                    ) {
                      readingMessageId.current = null;
                      readingMessageKind.current = null;
                    }
                  }}
                >
                  <div className="continuity-message-meta">
                    <strong>{message.role === "user" ? copy.you : name}</strong>
                    <time dateTime={new Date(message.createdAt).toISOString()}>
                      {dateText(message.createdAt, language)}
                    </time>
                  </div>
                  <p>
                    <ResultText text={message.content} language={language} />
                  </p>
                  {draftsByMessage.get(message.id)?.map(draftCard)}
                </article>
              ))}
            </div>
            {unanchoredDrafts.length > 0 ? (
              <section className="continuity-unanchored-drafts" aria-label={copy.draft}>
                {unanchoredDrafts.map(draftCard)}
              </section>
            ) : null}
          </div>
          <div className="continuity-compose-area">
            <div
              className="continuity-draft-announcements continuity-sr-only"
              aria-live="polite"
              aria-relevant="additions"
              aria-atomic="false"
            >
              {draftArrivals.pending.map((arrival) => (
                <span key={JSON.stringify([arrival.id, arrival.content])}>
                  {arrival.kind === "new" ? copy.newDraft : copy.updatedDraft} · {arrival.title}
                </span>
              ))}
            </div>
            {hasFeedback ? (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: 長い通知全文をキーボードでスクロールできるようにする。
              <section className="continuity-feedback" aria-label={copy.feedback} tabIndex={0}>
                {activity ? (
                  <p className="continuity-state" role="status">
                    {busy ? <LoaderCircle size={13} aria-hidden="true" /> : null}
                    {activity}
                  </p>
                ) : null}
                {pendingReply ? (
                  <div className="continuity-pending-reply">
                    <span>{copy.replyRequested}</span>
                    <button
                      type="button"
                      className="continuity-text-button"
                      aria-controls={pendingReplyId}
                      onClick={showPendingReply}
                    >
                      {copy.viewQuestion}
                      <ArrowUp size={13} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
                {draftArrivals.pending.map((arrival) => (
                  <div className="continuity-draft-arrival" key={arrival.id}>
                    <button
                      type="button"
                      className="continuity-text-button"
                      onClick={() => openDraft(arrival, true)}
                    >
                      {arrival.kind === "new" ? copy.newDraft : copy.updatedDraft} · {arrival.title}
                      <ArrowUp size={13} aria-hidden="true" className="continuity-diagonal-arrow" />
                    </button>
                  </div>
                ))}
                {showVoiceError ? (
                  <div className="continuity-error" role="alert">
                    <p>
                      {additionalVoiceError}
                      <br />
                      {copy.recovery.voice}
                    </p>
                  </div>
                ) : null}
                {feedbackErrors.map((failure) => {
                  const workError = failure.source === "work";
                  const syncFailure = failure.source === "sync";
                  const pending = retryPending === failure.source;
                  const hint = failure.source === "work" ? null : copy.recovery[failure.source];
                  return (
                    <Fragment key={failure.source}>
                      <div className="continuity-error" role="alert">
                        <p>
                          {failure.message}
                          {hint ? (
                            <>
                              <br />
                              {hint}
                            </>
                          ) : null}
                          {workError && automaticRecheck ? (
                            <>
                              <br />
                              {copy.automaticRecheckAfter}
                              <time dateTime={automaticRecheck.dateTime}>
                                {automaticRecheck.label}
                              </time>
                              {copy.automaticRecheckHint}
                            </>
                          ) : null}
                        </p>
                        {workError || syncFailure ? (
                          <button
                            type="button"
                            disabled={(workError && busy) || sending || retryPending !== null}
                            aria-busy={pending || undefined}
                            onClick={() => void retry(syncFailure ? "sync" : "work")}
                          >
                            {syncFailure
                              ? pending
                                ? copy.refreshing
                                : copy.refresh
                              : pending
                                ? copy.retrying
                                : copy.retry}
                          </button>
                        ) : null}
                        {workError && executionBackend === "pi" ? (
                          <button
                            type="button"
                            disabled={piDiagnostics.checking}
                            onClick={() => void piDiagnostics.check()}
                          >
                            {piDiagnostics.checking
                              ? copy.piDiagnostics.checking
                              : copy.piDiagnostics.check}
                          </button>
                        ) : null}
                      </div>
                      {workError && executionBackend === "pi" && piDiagnostics.result ? (
                        <div className="continuity-error" role="status" aria-live="polite">
                          <p>
                            {piDiagnosticMessages(piDiagnostics.result)
                              .map((message) => copy.piDiagnostics[message])
                              .join("\n")}
                          </p>
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
                {unread ? (
                  <button
                    type="button"
                    className="continuity-new-reply"
                    onClick={() => showUnreadMessage(unreadIds[0])}
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
                      onClick={() => setInputDrafts(cancelCorrection)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </section>
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
                  setInputDrafts((current) => editContinuityInput(current, text));
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
                      <button type="button" className="continuity-text-button" onClick={endVoice}>
                        {copy.end}
                      </button>
                    </>
                  ) : callConnecting || voicePending ? (
                    <>
                      <button
                        type="button"
                        className="continuity-icon"
                        disabled
                        aria-label={copy.connecting}
                        title={copy.connecting}
                      >
                        <LoaderCircle size={16} aria-hidden="true" />
                      </button>
                      <button type="button" className="continuity-text-button" onClick={endVoice}>
                        {copy.cancelConnection}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="continuity-icon"
                      aria-label={copy.talk}
                      title={copy.talk}
                      onClick={() => void startVoice()}
                    >
                      <Mic size={16} aria-hidden="true" />
                    </button>
                  )
                ) : null}
                <button
                  className="continuity-send"
                  type="submit"
                  disabled={
                    !draft.text.trim() || sending || (executionBackend === "pi" && !piReady)
                  }
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
                <div className="continuity-memory-actions">
                  <button
                    type="button"
                    className="continuity-text-button"
                    onClick={() => correct(entry)}
                  >
                    {copy.correct}
                  </button>
                  <button
                    type="button"
                    className="continuity-text-button"
                    aria-label={`${copy.forget} · ${entry.title}`}
                    onClick={() => showDetail({ kind: "forget", entry })}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    {copy.forget}
                  </button>
                </div>
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
          aria-describedby={selectedForget ? `${dialogTitleId}-scope` : undefined}
          aria-busy={forgetPending || undefined}
          onCancel={(event) => {
            event.preventDefault();
            closeDetail();
          }}
        >
          <header>
            <h2 id={dialogTitleId}>
              {detail.kind === "forget" ? copy.forgetTitle : (selectedDraft?.title ?? copy.source)}
            </h2>
            <button
              type="button"
              className="continuity-icon"
              aria-label={copy.closeDetail}
              disabled={forgetPending}
              onClick={() => closeDetail()}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </header>
          {error ? (
            <p className="continuity-error" role="alert">
              {error}
              {recoveryHint ? (
                <>
                  <br />
                  {recoveryHint}
                </>
              ) : null}
            </p>
          ) : null}
          {selectedForget ? (
            <>
              <h3>{selectedForget.title}</h3>
              <p className="continuity-draft-body">{selectedForget.value}</p>
              <p id={`${dialogTitleId}-scope`} className="continuity-forget-scope">
                {copy.forgetScope}
              </p>
              <p className="continuity-muted">{copy.forgetExistingContext}</p>
              <div className="continuity-detail-actions">
                <button
                  type="button"
                  ref={forgetCancelRef}
                  disabled={forgetPending}
                  onClick={() => closeDetail()}
                >
                  {copy.cancelForget}
                </button>
                <button
                  type="button"
                  disabled={forgetPending}
                  onClick={() => void forget(selectedForget)}
                >
                  {forgetPending ? copy.forgetting : copy.forget}
                </button>
              </div>
            </>
          ) : selectedDraft ? (
            <>
              <div className="continuity-draft-body">
                <ResultText text={selectedDraft.content} language={language} />
              </div>
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
                    disabled={actionPending || (executionBackend === "pi" && !piReady)}
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
