// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatApprovalRequest } from "./bindings/tauri-commands";
import { ChatView, type ChatViewProps } from "./chat-view";

afterEach(cleanup);

function props(overrides: Partial<ChatViewProps> = {}): ChatViewProps {
  return {
    language: "en",
    residentName: "Yori",
    messages: [],
    draft: "hello",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onOpenTerminal: vi.fn(),
    status: "ready",
    ...overrides,
  };
}

function approval(overrides: Partial<ChatApprovalRequest> = {}): ChatApprovalRequest {
  return {
    id: "request-1",
    sessionId: "session-1",
    agent: "claude",
    conversationId: "conversation-1",
    title: "Run command",
    detail: "git status --short",
    choices: [
      { id: "allow", label: "allowOnce", detail: null },
      { id: "deny", label: "deny", detail: null },
    ],
    ...overrides,
  };
}

describe("ChatView", () => {
  it("keeps multiline drafts and only sends Enter outside IME composition", () => {
    const settings = props({ draft: "first line\nsecond line" });
    render(<ChatView {...settings} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toBe("first line\nsecond line");

    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(settings.onSend).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "first line\nsecond line\nthird line" } });
    expect(settings.onDraftChange).toHaveBeenCalledWith("first line\nsecond line\nthird line");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(settings.onSend).toHaveBeenCalledOnce();
  });

  it.each([
    { draft: " \n\t" },
    { inputDisabled: true },
    { status: "loading" as const },
    { status: "unavailable" as const },
  ])("cannot send empty or disabled input: %j", (override) => {
    const settings = props(override);
    render(<ChatView {...settings} />);
    expect(
      (screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.submit(screen.getByRole("form", { name: "Message" }));
    expect(settings.onSend).not.toHaveBeenCalled();
  });

  it("renders untrusted messages and code as text without executing HTML or creating links", () => {
    const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const code = '  <button onclick="alert(3)">x</button>\n    next();\n';
    render(
      <ChatView
        {...props({
          messages: [
            {
              id: "reply",
              role: "assistant",
              text: `${attack}\nline two\n\`\`\`html\n${code}\`\`\`\n[jump](javascript:alert(4))`,
            },
          ],
        })}
      />,
    );
    const transcript = screen.getByRole("log");
    expect(transcript.textContent).toContain(attack);
    expect(transcript.textContent).toContain("\nline two\n");
    expect(transcript.querySelector("pre code")?.textContent).toBe(code);
    expect(transcript.querySelector("img, script, a, button")).toBeNull();
  });

  it("preserves a code block while its closing fence has not arrived", () => {
    render(
      <ChatView
        {...props({
          messages: [{ id: "reply", role: "assistant", text: "Example:\n~~~js\n  let value = 1;" }],
        })}
      />,
    );
    expect(screen.getByRole("log").querySelector("pre code")?.textContent).toBe("  let value = 1;");
  });

  it("keeps the reader's scroll position and focus until they request new messages", () => {
    const initial = props({
      messages: [{ id: "one", role: "assistant", text: "Earlier message" }],
    });
    const { rerender } = render(<ChatView {...initial} />);
    const transcript = screen.getByRole("log");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1500 },
      clientHeight: { configurable: true, value: 400 },
    });
    transcript.scrollTop = 200;
    fireEvent.scroll(transcript);
    const input = screen.getByRole("textbox");
    input.focus();

    const updated = props({
      messages: [...initial.messages, { id: "two", role: "assistant", text: "New message" }],
    });
    rerender(<ChatView {...updated} />);
    expect(transcript.scrollTop).toBe(200);
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "New messages" }));
    expect(transcript.scrollTop).toBe(1500);
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();

    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1700 });
    rerender(
      <ChatView
        {...updated}
        messages={[...updated.messages, { id: "three", role: "user", text: "Following again" }]}
      />,
    );
    expect(transcript.scrollTop).toBe(1700);
    expect(document.activeElement).toBe(input);
  });

  it("does not mark unchanged messages as unread on a host refresh", () => {
    const settings = props({ messages: [{ id: "one", role: "assistant", text: "Same message" }] });
    const { rerender } = render(<ChatView {...settings} />);
    const transcript = screen.getByRole("log");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1500 },
      clientHeight: { configurable: true, value: 400 },
    });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    rerender(
      <ChatView {...settings} messages={settings.messages.map((message) => ({ ...message }))} />,
    );
    expect(screen.queryByRole("button", { name: "New messages" })).toBeNull();
    expect(transcript.scrollTop).toBe(100);
  });

  it("localizes attention and error states and keeps the terminal reachable", () => {
    const settings = props({ language: "ja", status: "attention", error: "接続に失敗しました" });
    render(<ChatView {...settings} />);
    expect(screen.getByRole("status").textContent).toBe("入力の確認が必要です。");
    expect(screen.getByRole("alert").textContent).toBe("接続に失敗しました");
    fireEvent.click(screen.getByRole("button", { name: "ターミナルを開く" }));
    expect(settings.onOpenTerminal).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeTruthy();
  });

  it("renders an honest empty state and optional voice control", () => {
    const settings = props({ onToggleVoice: vi.fn() });
    const { rerender } = render(<ChatView {...settings} />);
    expect(screen.getByText("Your conversation will appear here.")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Start voice conversation" }));
    expect(settings.onToggleVoice).toHaveBeenCalledOnce();
    rerender(<ChatView {...settings} voiceActive />);
    expect(screen.getByRole("button", { name: "End voice conversation" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Voice conversation is active");
  });

  it("keeps the terminal action beside the composer hint and omits the top Chat header", () => {
    const settings = props();
    const { container } = render(<ChatView {...settings} />);
    expect(screen.queryByRole("heading", { name: "Chat" })).toBeNull();
    expect(container.querySelector("header")).toBeNull();
    const terminal = screen.getByRole("button", { name: "Open terminal" });
    expect(terminal.closest(".chat-view-footer")?.textContent).toContain("Enter to send");
    fireEvent.click(terminal);
    expect(settings.onOpenTerminal).toHaveBeenCalledOnce();
  });

  it("allows drafting and sending text while voice conversation remains active", () => {
    const settings = props({ voiceActive: true, onToggleVoice: vi.fn() });
    render(<ChatView {...settings} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "A typed follow-up" } });
    expect(settings.onDraftChange).toHaveBeenCalledWith("A typed follow-up");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(settings.onSend).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(settings.onSend).toHaveBeenCalledTimes(2);
    expect(settings.onToggleVoice).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Voice conversation is active");
  });

  it("sends the exact approval id and decision from the request's own buttons", () => {
    const settings = props({
      language: "ja",
      approvals: [approval(), approval({ id: "request-2", title: "Edit file" })],
      onResolveApproval: vi.fn(),
    });
    render(<ChatView {...settings} />);
    const first = within(screen.getByRole("region", { name: "Run command" }));
    const second = within(screen.getByRole("region", { name: "Edit file" }));
    fireEvent.click(second.getByRole("button", { name: "今回だけ承認" }));
    expect(settings.onResolveApproval).toHaveBeenLastCalledWith("request-2", "allow");
    fireEvent.click(first.getByRole("button", { name: "拒否" }));
    expect(settings.onResolveApproval).toHaveBeenLastCalledWith("request-1", "deny");
    expect(settings.onResolveApproval).toHaveBeenCalledTimes(2);
    expect(settings.onSend).not.toHaveBeenCalled();
  });

  it("only renders provided decisions and disables a busy request without disabling other cards", () => {
    const settings = props({
      approvals: [
        approval(),
        approval({
          id: "request-2",
          title: "Blocked request",
          choices: [{ id: "deny", label: "deny", detail: null }],
        }),
      ],
      approvalBusyIds: ["request-1"],
      onResolveApproval: vi.fn(),
      approvalError: "The request is still pending. Try again.",
    });
    render(<ChatView {...settings} />);
    const first = screen.getByRole("region", { name: "Run command" });
    expect(first.getAttribute("aria-busy")).toBe("true");
    for (const button of within(first).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(settings.onResolveApproval).not.toHaveBeenCalled();
    const second = within(screen.getByRole("region", { name: "Blocked request" }));
    expect(second.queryByRole("button", { name: "Allow once" })).toBeNull();
    const deny = second.getByRole("button", { name: "Deny" }) as HTMLButtonElement;
    expect(deny.disabled).toBe(false);
    fireEvent.click(deny);
    expect(settings.onResolveApproval).toHaveBeenCalledWith("request-2", "deny");
    expect(screen.getByRole("alert").textContent).toBe(settings.approvalError);
  });

  it("offers session approval beside once and deny, and sends its exact opaque choice ID", () => {
    const sessionScope = "Command: npm run test\nScope: this session only";
    const settings = props({
      language: "ja",
      approvals: [
        approval({
          choices: [
            { id: "allow", label: "allowOnce", detail: null },
            { id: "choice-session-27", label: "allowSession", detail: sessionScope },
            { id: "deny", label: "deny", detail: null },
          ],
        }),
      ],
      onResolveApproval: vi.fn(),
    });
    render(<ChatView {...settings} />);
    const card = screen.getByRole("region", { name: "Run command" });
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "今回だけ承認",
      "このセッション中は許可",
      "拒否",
    ]);
    expect(card.querySelector(".chat-view-approval-scope code")?.textContent).toBe(sessionScope);
    expect(card.querySelector("details")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "このセッション中は許可" }));
    expect(settings.onResolveApproval).toHaveBeenCalledExactlyOnceWith(
      "request-1",
      "choice-session-27",
    );
  });

  it("shows the full rule target inline and passes each offered choice unchanged", () => {
    const rule = `<script>alert(1)</script>\n${"  exact/path\n".repeat(100)}scope: saved command rule`;
    const settings = props({
      approvals: [
        approval({
          choices: [
            { id: "allow", label: "allowOnce", detail: null },
            { id: "saved-rule-3", label: "allowRule", detail: rule },
            { id: "network-9", label: "allowNetwork", detail: "Host: api.example.test:443" },
            { id: "blocked-host-8", label: "denyNetwork", detail: "Host: blocked.example.test" },
            { id: "deny", label: "deny", detail: null },
          ],
        }),
      ],
      onResolveApproval: vi.fn(),
    });
    render(<ChatView {...settings} />);
    const card = screen.getByRole("region", { name: "Run command" });
    const choices = card.querySelectorAll("details");
    expect(choices).toHaveLength(3);
    expect(settings.onResolveApproval).not.toHaveBeenCalled();
    for (const choice of choices) {
      fireEvent.click(choice.querySelector("summary") as HTMLElement);
      expect(choice.open).toBe(true);
      expect(settings.onResolveApproval).not.toHaveBeenCalled();
    }
    expect(choices[0].querySelector("pre code")?.textContent).toBe(rule);
    expect(choices[0].querySelector("pre")?.tabIndex).toBe(0);
    expect(card.querySelector("img, script, a, iframe")).toBeNull();
    fireEvent.click(within(choices[0]).getByRole("button", { name: "Save rule and allow" }));
    expect(settings.onResolveApproval).toHaveBeenLastCalledWith("request-1", "saved-rule-3");
    fireEvent.click(within(choices[1]).getByRole("button", { name: "Save network allow rule" }));
    expect(settings.onResolveApproval).toHaveBeenLastCalledWith("request-1", "network-9");
    fireEvent.click(within(choices[2]).getByRole("button", { name: "Save network deny rule" }));
    expect(settings.onResolveApproval).toHaveBeenLastCalledWith("request-1", "blocked-host-8");
  });

  it("disables every decision for a busy request, including expanded persistent choices", () => {
    const settings = props({
      approvals: [
        approval({
          choices: [
            { id: "allow", label: "allowOnce", detail: null },
            { id: "session-1", label: "allowSession", detail: "This session only" },
            { id: "rule-2", label: "allowRule", detail: "Rule: npm test" },
            { id: "deny", label: "deny", detail: null },
          ],
        }),
      ],
      approvalBusyIds: ["request-1"],
      onResolveApproval: vi.fn(),
    });
    render(<ChatView {...settings} />);
    const card = screen.getByRole("region", { name: "Run command" });
    fireEvent.click(card.querySelector("summary") as HTMLElement);
    const buttons = within(card).getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(settings.onResolveApproval).not.toHaveBeenCalled();
  });

  it("does not offer an active decision if no approval responder is available", () => {
    render(<ChatView {...props({ approvals: [approval()] })} />);
    expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("preserves all untrusted request details as inert text, including trailing command scope", () => {
    const title = '<img src=x onerror="alert(1)">';
    const detail = `<script>alert(2)</script>\n${"  file/path\n".repeat(200)}&& rm -rf /important`;
    render(<ChatView {...props({ approvals: [approval({ title, detail })] })} />);
    const request = screen.getByRole("region", { name: title });
    expect(within(request).getByRole("heading").textContent).toBe(title);
    expect(request.querySelector("pre code")?.textContent).toBe(detail);
    expect(request.querySelector("img, script, a, iframe")).toBeNull();
    expect(request.querySelector("pre")?.tabIndex).toBe(0);
  });

  it("does not steal focus or resolve a new request when Enter is used in the composer", () => {
    const settings = props({ onResolveApproval: vi.fn() });
    const { rerender } = render(<ChatView {...settings} />);
    const input = screen.getByRole("textbox");
    input.focus();
    rerender(<ChatView {...settings} approvals={[approval()]} />);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(settings.onSend).toHaveBeenCalledOnce();
    expect(settings.onResolveApproval).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
});
