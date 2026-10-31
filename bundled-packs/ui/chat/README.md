# Chat

A Main Agent conversation view beside the existing resident viewport. Choose **View Mode → Chat** or press **Option+Command+5** on macOS (**Control+Alt+5** elsewhere). Existing View Mode shortcuts keep their slots. Shell tabs retain their terminal interface.

The host renders the conversation and owns the composer. This pack selects the view and declares the existing shell as its presence surface; it does not receive a terminal-write API or manipulate the camera. Scene colors continue to supply the chat palette.

## Conversation and input

- Codex displays text from the selected conversation's latest 100 turns, including exchanges made in Terminal.
- Claude displays conversation events observed during the current app session. Replies appear when complete. Historical transcript hydration and token-by-token streaming are not implemented.
- Enter sends; Shift+Enter adds a line. IME confirmation does not submit a message. Multiline input requires the agent terminal's bracketed-paste support.
- When native terminal input is unfinished or uncertain, Chat preserves its draft. Use **Open terminal** below the composer to switch to Terminal View and finish that interaction before returning to Chat.
- Text composition and sending remain available during GPT Live. Approval requests temporarily hold message submission until answered.
- Conversation capture currently supports Codex and Claude. Other agents remain available in Terminal View.

## Approvals and interactive prompts

Supported approval requests appear as cards directly above the composer. Read the command or tool input and choose from the options offered by the agent, such as **Allow once**, **Allow for this session**, or **Deny**. Saved-rule choices expand inline to show the affected command prefix, network destination, or Claude permission rule and its destination before applying it. The selected provider decision is returned to that exact pending request; Chat does not send terminal keys or invent permission rules. Codex command/file approvals use its existing TUI connection, and Claude tool approvals use its synchronous PermissionRequest hook.

Only decisions offered by the provider are shown. Codex requests without a complete command, file diff, or network destination cannot be allowed from Chat. Other interactive questions, Codex permission/stdin requests, and Claude sandbox network prompts still use Terminal View. **Open terminal** switches views while preserving the process and conversation; there is no embedded terminal panel. Claude approval cards require a session launched with the updated hook configuration.

Leaving Chat releases any held Claude request to its normal approval dialog. Expired, disconnected, already answered, or old-conversation cards cannot be submitted.

## Implementation

- Presentation: `src/chat-view.tsx`, `src/chat-view.css`.
- Conversation observation: `src/runtime/chat-transcript.ts`, `src/runtime/use-chat-conversation.ts`, existing Codex thread tracker.
- Host integration and View Mode switching: `src/App.tsx`.
- Approval observation and responses: `src/runtime/use-chat-approvals.ts`, `src-tauri/src/chat_approvals.rs`, the Codex TUI proxy, and Claude hook server.
- Explicit user input: host-only `TerminalRuntime.submitChatText`.

See [design record](../../../docs/decisions/chat-view-mode.md) and [initial image proposal](../../../docs/design/chat-view-mode/README.md).
