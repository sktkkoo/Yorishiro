# Changelog

## Unreleased

- `docs/release-checklist.md` no longer describes builds as alpha: the smoke test targets signed release builds, and the `xattr -cr` step is scoped to locally built unsigned bundles.
- Internal release procedure notes were moved out of the repository (`.github/RELEASE.md` removed); `.github/` contents are published when the repository is public.
- Terminology unified: the layer contrasted with the reflex layer is now consistently called the thinking layer (思考層) across philosophy (EN/JA), decision docs, code-navigation READMEs, and code comments; it was previously mixed with "conscious layer" (意識層). Identifiers (`two-layer`, `TwoLayer`, etc.) are unchanged.

- Contribution policy clarified: pull requests remain closed and will be revisited after the pack API and security boundary stabilize (README / CONTRIBUTING, EN/JA).
- Added a top-of-README security note (EN/JA): user packs are local trusted code and are not sandboxed; in-app community pack distribution is not implemented yet.
- Added `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
- `scripts/fetch-assets.mjs` no longer fails on a fresh clone: a missing external asset store now warns and continues so source builds still run. Release/packaging builds set `CHARMINAL_ASSETS_REQUIRED=1` to fail closed when assets are absent.
- Asset credits tidied: the bundled `abandoned-factory_piano-loop.mp3` (CC0) is now listed in `CREDITS.md` / `CREDITS.ja.md`, and the shared sounds credits table no longer carries unshipped TBD entries.
- `abandoned-factory` scene no longer declares ambient `sound:` references that ship no audio; it keeps the bundled CC0 piano loop.
- Fixed a stale scene-controls unit test so the suite reflects the current `simple-room` lighting rig.

## 0.5.1 - 2026-06-22

- The SDK author guide is now shipped to `~/.charminal/sdk-guide.md` (rewritten on every startup), so the inhabitant AI can read the pack-authoring narrative even in packaged builds where the source tree is absent.
- Every bundled pack now ships a README, and the `/charm` command docs reference packs and SDK types through production-available paths (`bundled_example_read` MCP tool, `~/.charminal/sdk.d.ts` / `sdk-guide.md`).
- CLAI's idle-triggered TextPhysics mischief is back (a single low-probability roll after a long idle).
- Camera fixes: `camera-move` now works while tracking is off, F2 opens with tracking off by default, and the tutorial camera paths were corrected.
- The shoot timeline is now single-flight, so rapid repeated presses no longer overlap.

## 0.5.0 - 2026-06-19

- Motion size: a Settings slider and `motionIntensity` config field (0–3, default 1.0) scale CLAI's idle sway, breathing, and head/posture motion; inhabitants can adjust it through the `motion_intensity_set` MCP tool.
- Richer idle aliveness: idle beat scheduler (glances, micro-aversions, anticipation), eye-lead gaze with head recruitment, physiological state-dependent blink rates (suppressed while reading), and StatePose blending in ProceduralBones.
- User scene packs can be authored as R3F (TSX) components, with live reload from nested source edits.
- Scene layers support a drop-shadow filter.
- Inhabitants can read bundled pack sources through MCP (`bundled_example_read`) as authoring references.
- The restore UI now lists up to 30 snapshots.
- The first-run tutorial was reworked: fixed sleeps removed, effect shortcuts (F1/F3/F4) demonstrated in place, scene color-theme collaboration shown, and the flow now carries through the pack-creation experience.
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
