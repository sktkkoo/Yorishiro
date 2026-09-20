# Chat View Mode keeps the resident camera and handles approvals in conversation

Status: implemented in `feat/chat-view-mode`.

## Decision

Chat replaces the normal Main Agent terminal area with a host-owned transcript and composer. The existing resident viewport, camera, scene, title bar, project selector, and presence surface remain in place. Existing numbered View Mode shortcuts stay unchanged; Chat is appended at slot 5.

The first generated proposal placed conversation surfaces over a continuous scene. The accepted implementation uses the existing terminal area to preserve camera behavior. Moving the physical camera sideways would change the viewing angle and conflict with the current eye-contact assumption: the `camera` gaze target resolves to zero yaw and pitch. The render loop also owns camera tracking and `lookAt`. Chat therefore introduces no camera translation, projection offset, or new camera claim.

## Conversation ownership

The host reads structured conversation data, not terminal escape sequences. Codex reads the selected thread's newest 100 turns through the existing authenticated tracker. Claude records authenticated, launch-scoped prompt and Stop hook events from the existing deduplicated host pipeline; this is current-app-session observation, not historical hydration. The final reply comes from `last_assistant_message`, since the transcript file can lag the Stop event. See [Claude hook documentation](https://code.claude.com/docs/en/hooks#stop-input).

Reads and submissions are scoped to the Main Agent and conversation. Switching conversations invalidates pending results. User-entered text is rendered as text, with readable code fences, and is never interpreted as HTML. The UI preserves a failed submission's draft and does not retry automatically.

The composer is a host-owned explicit user-input surface. UI packs, personas, and MCP do not gain an arbitrary PTY-write API. Multiline text uses bracketed paste and cannot become a sequence of independently submitted lines. Unfinished or uncertain native input prevents Chat submission rather than concatenating hidden drafts.

## Approvals

The chat has no embedded terminal panel or upper heading. Pending supported requests appear immediately above the composer, with their full command, directory, reason, or file diff and the provider-supported choices. **Allow once**, **Deny**, and **Allow for this session** are direct actions; saved command/network rules expand inline to show the exact scope before selection. A quiet **Open terminal** action below the composer switches to Terminal View while preserving the existing PTY and conversation. Unsupported interactive questions remain there.

Codex approvals are observed by the existing TUI WebSocket proxy and answered through that same upstream connection. Opaque host tokens bind connection, original JSON-RPC ID, thread, turn, item, and selection revision. Chat and TUI responses are serialized; a consumed request cannot be answered again. The proxy forwards resolution to the TUI. Native storage binds every choice ID to the original decision payload, including session grants and provider-proposed command/network rules; the WebView cannot submit or modify a policy payload. Command/file and managed network approvals are supported; incomplete command/diff/destination information cannot be approved. Internal title-generation turns do not replace the approval connection’s selected conversation. See [Codex app-server approvals](https://learn.chatgpt.com/docs/app-server#approvals). Other permission requests, stdin requests, and interactive questions keep their native flow.

Claude uses an authenticated, explicitly negotiated synchronous PermissionRequest hook. Each held HTTP request receives a distinct opaque token and a Chat visibility lease. Clicking a button returns that request's hook response. When Claude proposes supported rule or directory updates, Chat shows their original destination and scope and returns the selected entry unchanged as `updatedPermissions`. Session grants and persisted rules have distinct labels. Allow once and Deny never include permission updates, and Chat never rewrites tool input or synthesizes a grant. Mode changes and unsupported suggestions remain in Terminal. Leaving Chat, disconnecting, changing conversations, or expiring the lease releases the request with no decision, so Claude displays its normal prompt. Existing sessions launched with the older notification-only hook configuration must be restarted to use cards. Sandbox network requests do not emit this hook and remain in Terminal. See [Claude PermissionRequest documentation](https://code.claude.com/docs/en/hooks#permissionrequest).

These are host-only user controls. Pack and MCP APIs do not gain approval authority. No decision is inferred from conversation text, and no approval keys are synthesized.

## Input and layout

The composer remains visible when long histories, approval details, or errors overflow. The conversation uses the remaining height; feedback details scroll separately. Native input ownership guards still prevent appending a Chat message to an unfinished terminal draft. GPT Live does not disable text entry or submission, allowing users to type while voice remains active.

## Verification boundary

Unit tests cover transcript filtering and ordering, provider/host isolation, stale asynchronous results, IME and multiline handling, native-input ownership, exact approval IDs, stale cards and leases, available decisions, and one-time responses. Rust WebSocket tests exercise Chat replies through the original connection and races with TUI replies; generated Claude hook scripts are executed against a fake HTTP transport to verify exact JSON responses.

Browser fixtures cover long histories and oversized approval/error details at 1280×800 and 900×600. Native preview capture confirmed the original input clipping; the layout fix was then checked in those fixtures and in the running app. A separate native preview with Codex 0.155.1 displayed an actual one-line command approval. This exposed and fixed a title-generation response clearing connection ownership; a WebSocket regression now delivers a fresh approval after that internal turn. Session and saved-rule response payloads are covered by protocol tests; persistent rules are not applied to the developer’s personal settings as part of automated validation.
