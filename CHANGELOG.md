# Changelog

## Unreleased

- Terminal agent launch is now backed by `TerminalAgent` adapters for Claude Code, Codex, and OpenCode.
- Codex installs Charminal commands as `$charm-*` skills instead of `/charm:*` slash commands.
- OpenCode receives Charminal commands as `/charm-*` custom commands through `OPENCODE_CONFIG_CONTENT`.
- OpenCode persona overlay is injected through `agent.build.prompt` and `agent.plan.prompt` file references so primary agents receive Charminal's system prompt.
- OpenCode TUI starts with a session-scoped `OPENCODE_TUI_CONFIG` temp config using the `system` theme, and Charminal sends OpenCode's `SIGUSR2` theme refresh hook on scene changes so panel/input colors re-sample the terminal palette without rewriting user OpenCode config files.
- Documented that Claude Code hooks are not a cross-agent contract; Codex/OpenCode hook-like surfaces require explicit per-agent capabilities before Charminal treats them as shared behavior.
- Agent `defaultProfile` values such as `"opencode"` now launch that agent instead of falling back to `terminalAgent`.
- `terminalAgent: "opencode"` is accepted in config. OpenCode end-to-end smoke is deferred and remains unverified on this machine.
- `UiAppAPI.setTerminalAgent` and related SDK/config types now accept string adapter ids instead of only `"claude" | "codex"`.
