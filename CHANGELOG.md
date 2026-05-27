# Changelog

## Unreleased

- Terminal agent launch is now backed by `TerminalAgent` adapters for Claude Code, Codex, and OpenCode.
- Codex installs Charminal commands as `$charm-*` skills instead of `/charm:*` slash commands.
- `terminalAgent: "opencode"` is accepted in config. OpenCode end-to-end smoke is deferred and remains unverified on this machine.
- `UiAppAPI.setTerminalAgent` and related SDK/config types now accept string adapter ids instead of only `"claude" | "codex"`.
