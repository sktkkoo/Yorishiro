# Changelog

## Unreleased

- Added Animates-inspired conversation controls to Portrait, Call, and Theater: tap Command to open a Spotlight-like Quick Chat input, or hold Command to start GPT Live. Quick Chat replies fall back to the macOS Voice Summary path when the agent did not already speak its own summary. While voice is connected, Command toggles microphone mute and a compact status pill provides explicit mute and end controls.

## 0.7.6 - 2026-08-31

- Added five extensible presentation modes—Terminal, Portrait, Call, Theater, and Immersive—with title-bar controls, `Option+Command+0` through `4` shortcuts, mode-specific native window sizing and framing, UI-pack metadata, and README previews for each layout.
- Fixed VRM head poses retaining a transient procedural gaze or tilt after an animation ends by restoring the neutral base rotation before animation playback.
- Hardened the macOS CLI so unknown commands show usage and fail instead of unexpectedly launching the GUI, and documented command installation plus the `list`, `attach`, and `companion` external-terminal workflow.

## 0.7.5 - 2026-08-29

- Fixed GPT Live local-work delegation after the first voice turn by keeping it attached to the durable workspace thread across automatic title generation and voice reconnection, preventing internal title threads from producing misleading completion reports.
- Updated Settings to show imported VRM model names instead of opaque filenames, with a filename fallback when metadata does not declare a name, and added a dedicated custom-avatar guide to the English and Japanese READMEs.
- Strengthened macOS release verification by checking packaged app signatures and entitlements before release assets are uploaded.

## 0.7.4 - 2026-08-26

- Added macOS external-terminal companion mode: `yorishiro companion` launches and connects in one step, while `yorishiro attach` joins a running session through a local authenticated transport without losing the in-app terminal view.
- Improved Codex session recovery so a stopped or locked latest thread can fall back to a fresh session when history forking cannot proceed.
- Preserved and displayed the VRM specification version declared by imported avatars instead of replacing it with the parser's normalized version.
- Fixed GPT Live startup with current Codex app-server builds by selecting the supported Codex realtime model explicitly and waiting for asynchronous SDP or error notifications.

## 0.7.3 - 2026-08-16

- Added Claude Code conversation history navigation: Main Agent New / Back / Forward now works with Claude Code, resuming exact conversations from the observed session ID and restoring the previous conversation when navigation fails. Claude hooks are isolated per app instance and PTY launch with a dynamic loopback port and scoped tokens.
- Isolated runtime MCP endpoints per Yorishiro instance so production and development builds can run side by side; the owned endpoint is injected into Claude Code, Codex, and OpenCode, and reported in MCP status and Health.
- Redesigned the VRM import and selection experience as a bounded modal chooser with embedded thumbnails, creator and VRM spec-version rows, grouped expression permissions, safe HTTPS license links, and a progressive catalog. Import and selection only open a candidate; the explicit switch action changes the active avatar. Managed entries can be removed from the list without deleting the original source VRM, repeated imports are idempotent, and the bundled Yori thumbnail is extracted at build time.
- Added a shared Voice Volume setting with mute, applied live to Voice Summary, voice playback, and GPT Live audio; the audio mixer is presented as `Ambient Sound / Voice` (`環境音 / 音声`).
- Added a regression test that keeps `index.html` free of inline styles so the CSP black-screen failure cannot be reintroduced.

## 0.7.2 - 2026-08-15

- Added one-click Main Agent conversation controls: start fresh or move Back and Forward through recent conversations without closing shell tabs or resetting the workspace. Conversation replacement is serialized, GPT Live reconnects when needed, and a failed navigation restores the exact outgoing Codex session.
- Expanded local TSX Pack authoring with Ambient UI discovery, compilation, hot reload, diagnostics, shared React Three Fiber post-processing modules, pack-local asset resolution, and distributed SDK declarations. Public host capabilities now cover controls, attention cues, app version, HTTPS links, and confirmed history restore without exposing internal registries or raw Tauri APIs.
- Added a stable Amenity service boundary for Ambient UI state reads and commands, and migrated the bundled Pomodoro UI to that public contract.
- Fixed active Ambient UI disappearing after an atomic save or hot reload by reapplying configured activation only after successful registration while preserving inactive and deleted states.
- Added direct terminal links: Cmd+click opens a visible HTTP/HTTPS URL in the default browser. Whole-line Terminal Reference Marker capture moved to Cmd+Shift+click; Option+Shift+drag remains unchanged.
- Fixed development-time React Three Fiber context splits after Vite dependency re-optimization, and isolated scene render failures so the VRM, shared controls, fallback lighting, and scene switching remain available.

## 0.7.1 - 2026-08-08

- Fixed Codex startup after updating from pre-registry source or pre-release builds by safely reaping only narrowly verified, clientless orphan app-server sidecars. Process identity, connection state, and the latest sidecar registry are rechecked around signal delivery to avoid terminating active or unrelated Codex integrations.
- Codex session startup remains resume-first. If another legitimate Codex client already owns the latest thread's writer lock, Yorishiro now keeps that client alive and forks the thread history instead of failing to launch. Other resume errors are still reported unchanged.
- New Codex app-server sidecars now fail closed when their ownership record cannot be persisted, preventing another untracked orphan from being created.

## 0.7.0 - 2026-08-08

- Added GPT Live voice conversations for Codex 0.145.0 and newer. Voice and text share the active Codex thread, the normal TUI remains visible, and microphone capture is controlled from the title bar.
- Added global and per-persona GPT Live voice selection, with explicit fallback when a selected voice is rejected. Voice follows workspace and session changes and recovers across thread clearing and transient connection failures.
- Added Agent State Expression: provider-grounded conversational cues coordinate facial expression and body motion through a centralized arbitration layer while preserving blinks, reflexes, speech ownership, and newer playback intents.
- Voice Summary now acts as a fallback for GPT Live, and realtime playback ownership is generation-stamped to reject stale or reordered audio events without leaving lip sync or expression state behind.
- Fixed the microphone indicator so it reflects actual capture state, with clearer active, connecting, and failure states.
- Fixed leaked Codex app-server sidecars preventing later sessions from starting. Yorishiro now tracks sidecar ownership, tears sessions down on exit, and safely reaps verified orphans at startup.
- Fixed macOS production signing so release bundles apply the required audio-input, network-client, JIT, and unsigned-executable-memory entitlements; local production bundles use ad-hoc signing for equivalent verification.
- Added `Cmd+,` / `Ctrl+,` to toggle Settings. Fixed Bash `bind -x` commands being misreported as terminal runs (including Bash 3.x), and stopped Fish OSC escaping from expanding safe ASCII bytes. Thanks to @soren-achebe for the reports, diagnosis, and Bash fix suggestions.
- Capitalized the macOS app bundle from `yorishiro.app` to `Yorishiro.app`, matching the product branding. Thanks to @tacomanator for the suggestion.
- Documented the public development-language policy and promoted Codex and GPT Live throughout the English and Japanese project documentation.

## 0.6.2 - 2026-07-25

- Speaking now activates the whole face. A speech reflex layer derives brow/eye engagement, phrase-boundary blinks, and prosodic brow flicks from the lip-sync audio signal, so Yori no longer talks with an idle face and a moving mouth. No emotion is inferred from the audio.
- `voice_say` accepts an optional `mood` / `moodIntensity`. The expression fades in when the utterance starts and releases when it ends, so a mood lasts exactly as long as the line it belongs to. Omitting `mood` behaves exactly as before.
- Persona packs can ship their own `avatar.vrm`. Switching persona from Settings or through `persona_goodbye_switch` now applies it automatically, instead of changing the body only when a VRM path was pasted by hand. An explicit `vrmPath` still takes precedence, and a failed lookup never blocks the switch.
- Reflexes are inspectable. `Trigger.description` declares in one human-readable line what makes a reflex fire, and the new `persona_reflex_list` MCP tool lists a persona's triggers and responses — including whether the persona defines its own reflexes or inherits the bundled defaults wholesale.
- `PersonaDefinition` is now two axes: thinking and reflex. The declared-but-unconsumed `world` (body / voice / space) and `logReading` axes were removed. Existing packs that declare them keep loading (the fields are ignored) and runtime behavior is unchanged.
- UI packs can set terminal `backgroundOpacity` (0–1), so a readable semi-transparent terminal can sit over a scene. The tint is bridged into the surrounding frame padding so no gap shows, and `ui_terminal_set` exposes the same control independently. The existing `transparentBackground` boolean remains compatible.
- Fixed user packs failing to bundle when `scene.tsx` / `ui.tsx` imported a pack-local module such as `./lib/palette`: the TSX transpiler passed an option esbuild rejects during resolve.
- The F2 debug panel's `speech` folder is now opt-in (`localStorage.setItem("yorishiro:speech-debug", "1")`), so `Common` stays a place for controls that are meaningful whenever you open it. The reflex layer itself runs identically either way.
- README now leads with the demo video, with mobile-friendly media and a tightened closing vision (EN / JA).
- The Contributing sections now say plainly that Issues and Discussions are wanted, and what kinds of reports are useful (EN / JA).

## 0.6.1 - 2026-07-14

- Settings offers a "Return to Yori" action while a custom VRM is selected, so the bundled model can be restored without owning a standalone copy of its VRM file. Imported VRM files stay on disk.

## 0.6.0 - 2026-07-14

- In-app updates: Settings checks GitHub Releases for a new version and applies a signature-verified update on a single click. Releases now ship updater artifacts and a `latest.json` manifest alongside the `.dmg` files.
- Light alerts now use a brighter, quicker double pulse with a distinct beat between flashes.
- Fixed Codex `$yori` command discovery by installing Yorishiro's generated skills in Codex's user skill directory (`~/.agents/skills`) instead of an undiscoverable plugin cache entry.
- Renamed the product from Charminal to Yorishiro, including app metadata, command namespace, SDK package naming, bundled docs, and automatic `~/.charminal/` → `~/.yorishiro/` data directory migration.
- Release asset fetching now fails packaging builds when `YORISHIRO_ASSETS_REQUIRED=1` is set and any required asset target is missing.
- Windows artifact builds are now manual-only: release tags no longer trigger the unsupported `Build Windows` workflow.

## 0.5.2 - 2026-07-04

- Session tabs moved into a custom title bar with polished labels, cwd-aware metadata, keyboard handling fixes, terminal-theme synchronization, and sidebar/fullscreen controls that no longer fight the window chrome.
- Agent/session status is now surfaced through the terminal itself: Claude hook notifications, shell-agent shims, OSC notification fallback, screen prompt detection, awaiting-input/exit/activity badges, and safer main-agent interrupt protection all target the correct session.
- Terminal command tracking was rebuilt around command-run, loop-run, agent-tool-run, unified-timeline, and terminal-problem stores. File tokens inside URLs are ignored, problem URLs are redacted to origins, command attention survives reload/attach paths, and stale command/aura state is cleared more reliably.
- `init.js` now hot reloads with transactional reload behavior, safe-mode awareness, serialized reloads, file-removal handling, and opt-in startup scope helpers such as `registerShortcut`.
- Scene and UI polish: scene-layer media can be transformed and sized as real off-screen cover panels, the fullscreen terminal can exit through the sidebar button, and `simple-room` was retuned to a neutral charcoal/sage look.
- Fireworks effects now use a WebGL2 GPU particle renderer with a softer bloom while preserving the CPU-era feel.
- Terminal input and agent prompt detection fixes: IME composition input is preserved, terminal clear keeps input lines, and Codex/choice/Claude permission prompts are detected more robustly.
- README and philosophy docs were rewritten around the Presence Harness / inhabited workspace framing, with reflex-vs-thinking terminology unified across docs and code comments.
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
- Yori's idle-triggered TextPhysics mischief is back (a single low-probability roll after a long idle).
- Camera fixes: `camera-move` now works while tracking is off, F2 opens with tracking off by default, and the tutorial camera paths were corrected.
- The shoot timeline is now single-flight, so rapid repeated presses no longer overlap.

## 0.5.0 - 2026-06-19

- Motion size: a Settings slider and `motionIntensity` config field (0–3, default 1.0) scale Yori's idle sway, breathing, and head/posture motion; inhabitants can adjust it through the `motion_intensity_set` MCP tool.
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
- Legacy `yori` persona removed; only `yori-en` and `yori-ja` remain.
