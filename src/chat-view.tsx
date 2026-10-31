import { ArrowDown, ArrowUp, Mic, SquareTerminal } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChatApprovalDecision, ChatApprovalRequest } from "./bindings/tauri-commands";
import "./chat-view.css";

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ChatViewProps {
  readonly language: "en" | "ja";
  readonly residentName: string;
  readonly messages: readonly ChatMessage[];
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onOpenTerminal: () => void;
  readonly status: "loading" | "ready" | "working" | "attention" | "unavailable";
  readonly error?: string | null;
  readonly inputDisabled?: boolean;
  readonly onToggleVoice?: () => void;
  readonly voiceActive?: boolean;
  readonly approvals?: readonly ChatApprovalRequest[];
  readonly onResolveApproval?: (id: string, decision: ChatApprovalDecision) => void;
  readonly approvalBusyIds?: readonly string[];
  readonly approvalError?: string | null;
}

const STRINGS = {
  en: {
    transcript: "Conversation",
    you: "You",
    terminal: "Open terminal",
    empty: "A little space to talk.",
    emptyDetail: "Your conversation will appear here.",
    loading: "Loading conversation…",
    working: "Working…",
    attention: "Your input is needed.",
    approvals: "Pending requests",
    allowOnce: "Allow once",
    deny: "Deny",
    allowSession: "Allow for this session",
    allowRule: "Save rule and allow",
    allowNetwork: "Save network allow rule",
    denyNetwork: "Save network deny rule",
    unavailable: "Chat is not available for this session. Continue in the terminal.",
    input: "Message",
    placeholder: (name: string) => `Message ${name}…`,
    send: "Send message",
    shortcut: "Enter to send · Shift + Enter for a new line",
    newMessages: "New messages",
    voiceStart: "Start voice conversation",
    voiceStop: "End voice conversation",
    voiceActive: "Voice conversation is active",
  },
  ja: {
    transcript: "会話",
    you: "あなた",
    terminal: "ターミナルを開く",
    empty: "ここから、話そう。",
    emptyDetail: "やりとりがここに残ります。",
    loading: "会話を読み込んでいます…",
    working: "作業中…",
    attention: "入力の確認が必要です。",
    approvals: "確認待ち",
    allowOnce: "今回だけ承認",
    deny: "拒否",
    allowSession: "このセッション中は許可",
    allowRule: "ルールを保存して今後も許可",
    allowNetwork: "通信の許可ルールを保存",
    denyNetwork: "通信の拒否ルールを保存",
    unavailable: "このセッションではチャットを利用できません。ターミナルで続けられます。",
    input: "メッセージ",
    placeholder: (name: string) => `${name}に話しかける…`,
    send: "送信",
    shortcut: "Enter 送信 · Shift + Enter 改行",
    newMessages: "新しいメッセージ",
    voiceStart: "音声会話を開始",
    voiceStop: "音声会話を終了",
    voiceActive: "音声で会話中",
  },
} as const;

interface MessageBlock {
  readonly offset: number;
  readonly code: boolean;
  readonly text: string;
}

// HTML は解釈せず、コードフェンスだけを読みやすい等幅ブロックに分ける。
function messageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n/gm;
  let offset = 0;
  let opening = fence.exec(text);
  while (opening) {
    if (opening.index > offset) {
      blocks.push({ offset, code: false, text: text.slice(offset, opening.index) });
    }
    const contentStart = fence.lastIndex;
    const marker = opening[1];
    const closingFence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?$`, "gm");
    closingFence.lastIndex = contentStart;
    const closing = closingFence.exec(text);
    const end = closing?.index ?? text.length;
    blocks.push({ offset: opening.index, code: true, text: text.slice(contentStart, end) });
    offset = closing ? closingFence.lastIndex : text.length;
    if (text[offset] === "\n") offset++;
    fence.lastIndex = offset;
    opening = fence.exec(text);
  }
  if (offset < text.length) blocks.push({ offset, code: false, text: text.slice(offset) });
  return blocks;
}

function ApprovalCard({
  request,
  strings,
  busy,
  onResolve,
}: {
  readonly request: ChatApprovalRequest;
  readonly strings: (typeof STRINGS)["en" | "ja"];
  readonly busy: boolean;
  readonly onResolve: ChatViewProps["onResolveApproval"];
}): React.ReactElement {
  const titleId = useId();
  const directChoices = request.choices.filter(
    (choice) =>
      choice.label === "deny" || choice.label === "allowOnce" || choice.label === "allowSession",
  );
  const scopedChoices = request.choices.filter(
    (choice) =>
      choice.label !== "deny" && choice.label !== "allowOnce" && choice.label !== "allowSession",
  );
  return (
    <section aria-busy={busy} aria-labelledby={titleId} className="chat-view-approval">
      <h3 className="chat-view-approval-title" id={titleId}>
        {request.title}
      </h3>
      <pre
        className="chat-view-approval-detail"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 承認対象の全文をキーボードでもスクロールして確認できるようにする。
        tabIndex={0}
      >
        <code>{request.detail}</code>
      </pre>
      {directChoices.map(
        (choice) =>
          choice.detail !== null && (
            <div className="chat-view-approval-direct-scope" key={choice.id}>
              <span>{strings[choice.label]}</span>
              <pre
                className="chat-view-approval-detail chat-view-approval-scope"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: 承認する範囲の全文をキーボードでも確認できるようにする。
                tabIndex={0}
              >
                <code>{choice.detail}</code>
              </pre>
            </div>
          ),
      )}
      <div className="chat-view-approval-actions">
        {directChoices.map((choice) => (
          <button
            className={
              choice.label === "allowOnce" ? "chat-view-approval-allow" : "chat-view-approval-deny"
            }
            disabled={busy || !onResolve}
            key={choice.id}
            onClick={() => onResolve?.(request.id, choice.id)}
            type="button"
          >
            {strings[choice.label]}
          </button>
        ))}
      </div>
      {scopedChoices.length > 0 && (
        <div className="chat-view-approval-options">
          {scopedChoices.map((choice) => (
            <details className="chat-view-approval-option" key={choice.id}>
              <summary>{strings[choice.label]}</summary>
              {choice.detail !== null && (
                <pre
                  className="chat-view-approval-detail chat-view-approval-scope"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: 保存する承認範囲の全文をキーボードでも確認できるようにする。
                  tabIndex={0}
                >
                  <code>{choice.detail}</code>
                </pre>
              )}
              <div className="chat-view-approval-actions">
                <button
                  className="chat-view-approval-deny"
                  disabled={busy || !onResolve}
                  onClick={() => onResolve?.(request.id, choice.id)}
                  type="button"
                >
                  {strings[choice.label]}
                </button>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

export function ChatView({
  language,
  residentName,
  messages,
  draft,
  onDraftChange,
  onSend,
  onOpenTerminal,
  status,
  error,
  inputDisabled = false,
  onToggleVoice,
  voiceActive = false,
  approvals = [],
  onResolveApproval,
  approvalBusyIds = [],
  approvalError,
}: ChatViewProps): React.ReactElement {
  const strings = STRINGS[language];
  const hintId = useId();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const following = useRef(true);
  const lastChange = useRef("");
  const [unread, setUnread] = useState(false);
  const lastMessage = messages[messages.length - 1];
  const messageChange = JSON.stringify([messages.length, lastMessage?.id, lastMessage?.text]);
  const disabled = inputDisabled || status === "loading" || status === "unavailable";
  const canSend = !disabled && draft.trim().length > 0;
  const statusText = voiceActive
    ? strings.voiceActive
    : status === "ready"
      ? null
      : strings[status];

  const scrollToLatest = () => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
    following.current = true;
    setUnread(false);
  };

  // 新着でも閲覧位置を奪わず、最下部を読んでいる間だけ追従する。
  useLayoutEffect(() => {
    if (lastChange.current === messageChange) return;
    lastChange.current = messageChange;
    if (following.current) {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    } else {
      setUnread(true);
    }
  }, [messageChange]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const content = contentRef.current;
    if (!transcript || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) transcript.scrollTop = transcript.scrollHeight;
    });
    observer.observe(transcript);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = draft ? `${Math.min(Math.max(input.scrollHeight, 28), 160)}px` : "28px";
  }, [draft]);

  const submit = () => {
    if (canSend && !composing.current) onSend();
  };

  return (
    <section aria-label={strings.transcript} className="chat-view" data-no-window-drag>
      <div className="chat-view-conversation">
        <div
          aria-label={strings.transcript}
          aria-relevant="additions text"
          className="chat-view-transcript"
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 72;
            if (following.current) setUnread(false);
          }}
          ref={transcriptRef}
          role="log"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: キーボードだけでも会話履歴をスクロールできるようにする。
          tabIndex={0}
        >
          {messages.length === 0 && status === "ready" && (
            <div className="chat-view-empty">
              <p>{strings.empty}</p>
              <span>{strings.emptyDetail}</span>
            </div>
          )}
          <ol className="chat-view-messages" ref={contentRef}>
            {messages.map((message) => (
              <li className="chat-view-message" data-role={message.role} key={message.id}>
                <span className="chat-view-speaker">
                  {message.role === "user" ? strings.you : residentName}
                </span>
                <div className="chat-view-bubble">
                  {messageBlocks(message.text).map((block) =>
                    block.code ? (
                      <pre className="chat-view-code" key={block.offset}>
                        <code>{block.text}</code>
                      </pre>
                    ) : (
                      <div className="chat-view-text" key={block.offset}>
                        {block.text}
                      </div>
                    ),
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
        {unread && (
          <button className="chat-view-new-messages" onClick={scrollToLatest} type="button">
            <ArrowDown aria-hidden="true" size={14} />
            {strings.newMessages}
          </button>
        )}
      </div>

      <div className="chat-view-bottom">
        <div className="chat-view-feedback" tabIndex={error || approvalError ? 0 : undefined}>
          {approvals.length > 0 && (
            <section aria-label={strings.approvals} className="chat-view-approvals">
              {approvals.map((request) => (
                <ApprovalCard
                  busy={approvalBusyIds.includes(request.id)}
                  key={request.id}
                  onResolve={onResolveApproval}
                  request={request}
                  strings={strings}
                />
              ))}
            </section>
          )}
          {approvalError && (
            <p className="chat-view-error" role="alert">
              {approvalError}
            </p>
          )}
          {statusText && (
            <p className="chat-view-status" data-status={status} role="status">
              {statusText}
            </p>
          )}
          {error && (
            <p className="chat-view-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <form
          aria-label={strings.input}
          className="chat-view-composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            aria-describedby={hintId}
            aria-label={strings.input}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                composing.current ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              ) {
                return;
              }
              event.preventDefault();
              submit();
            }}
            placeholder={strings.placeholder(residentName)}
            ref={inputRef}
            rows={1}
            value={draft}
          />
          <div className="chat-view-composer-actions">
            {onToggleVoice && (
              <button
                aria-label={voiceActive ? strings.voiceStop : strings.voiceStart}
                aria-pressed={voiceActive}
                className="chat-view-voice"
                onClick={onToggleVoice}
                title={voiceActive ? strings.voiceStop : strings.voiceStart}
                type="button"
              >
                <Mic aria-hidden="true" size={18} />
              </button>
            )}
            <button
              aria-label={strings.send}
              className="chat-view-send"
              disabled={!canSend}
              title={strings.send}
              type="submit"
            >
              <ArrowUp aria-hidden="true" size={19} />
            </button>
          </div>
        </form>
        <div className="chat-view-footer">
          <p className="chat-view-hint" id={hintId}>
            {strings.shortcut}
          </p>
          <button className="chat-view-terminal" onClick={onOpenTerminal} type="button">
            <SquareTerminal aria-hidden="true" size={13} />
            {strings.terminal}
          </button>
        </div>
      </div>
    </section>
  );
}
