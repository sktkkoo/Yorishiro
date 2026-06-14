# Changelog

## Unreleased

## 0.5.0 - 2026-06-14

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

## 0.4.0 - 2026-05-24

- macOS is now the only supported platform. Windows still compiles but its runtime behavior is unstable, and Linux is not yet available.
- Signed macOS builds are produced through GitHub Actions with code signing and notarization; release assets and private assets are fetched from R2 during CI.
- First-run health diagnostics surface environment problems before they become silent failures.
- A runtime crash recovery boundary keeps the app usable after a render-layer crash.
- Safe mode (`CHARMINAL_SAFE_MODE=1`) lets you recover from broken packs.
- Pack workbench refinements: kind groups, inline toggles, an active bar, and auto-refresh.
- Pack doctor diagnostics and a `pack diagnose` MCP tool for validating local packs.
- Pack repair handoff actions, hardened against id injection and double-click.
- Settings now show each pack's description, author, and trust tier; Quick Actions moved to the top.
- Settings UI labels are localized (Japanese / English); product terms stay in English.
- Render loop scheduling optimized to reduce idle CPU/GPU usage.
- Default bundled fallback scene changed to `simple-room`.
- Legacy `clai` persona removed; only `clai-en` and `clai-ja` remain.
