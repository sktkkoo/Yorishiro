# Changelog

## Unreleased

- Terminal agent launch is now backed by `TerminalAgent` adapters for Claude Code, Codex, and OpenCode.
- Codex installs Charminal commands as `$charm-*` skills instead of `/charm:*` slash commands.
- OpenCode receives Charminal commands as `/charm-*` custom commands through `OPENCODE_CONFIG_CONTENT`.
- OpenCode persona overlay is injected through `agent.build.prompt` and `agent.plan.prompt` file references so primary agents receive Charminal's system prompt.
- OpenCode TUI starts with a session-scoped `OPENCODE_TUI_CONFIG` temp config using the `system` theme, so it follows the Charminal terminal palette without rewriting user OpenCode config files.
- Agent `defaultProfile` values such as `"opencode"` now launch that agent instead of falling back to `terminalAgent`.
- `terminalAgent: "opencode"` is accepted in config. OpenCode end-to-end smoke is deferred and remains unverified on this machine.
- `UiAppAPI.setTerminalAgent` and related SDK/config types now accept string adapter ids instead of only `"claude" | "codex"`.
