# Changelog

## Unreleased

- Terminal agent launch is now backed by `TerminalAgent` adapters for Claude Code, Codex, and OpenCode.
- Codex installs Charminal commands as `$charm-*` skills instead of `/charm:*` slash commands.
- OpenCode receives Charminal commands as `/charm-*` custom commands through `OPENCODE_CONFIG_CONTENT`.
- OpenCode persona overlay is injected through `agent.build.prompt` and `agent.plan.prompt` file references so primary agents receive Charminal's system prompt.
- OpenCode TUI starts with a session-scoped `OPENCODE_TUI_CONFIG` temp config using the `system` theme, and Charminal sends OpenCode's `SIGUSR2` theme refresh hook on scene changes so panel/input colors re-sample the terminal palette without rewriting user OpenCode config files.
- Codex and OpenCode now receive Charminal journal/voice reminders through their launch prompt overlays instead of Claude Code hook output.
- Documented that Claude Code hooks are not a cross-agent contract; Codex/OpenCode hook-like surfaces require explicit per-agent capabilities before Charminal treats them as shared behavior.
- Agent `defaultProfile` values such as `"opencode"` now launch that agent instead of falling back to `terminalAgent`.
- The Settings Agent dropdown and the Status panel now report the agent that actually launches (honoring `defaultProfile`). When `defaultProfile` pins an agent, the dropdown shows that agent and is disabled with a "fixed by defaultProfile" note.
- Agent install directories and charm command syntax are now declared by each `TerminalAgent` adapter (single source of truth); the Status panel warns if the Rust adapter registry and the TypeScript mirror drift.
- `terminalAgent: "opencode"` is accepted in config. OpenCode end-to-end smoke is deferred and remains unverified on this machine.
- `UiAppAPI.setTerminalAgent` and related SDK/config types now accept string adapter ids instead of only `"claude" | "codex"`.
