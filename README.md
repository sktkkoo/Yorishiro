<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Yorishiro" width="160" />
</p>

<h1 align="center">yorishiro</h1>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/sktkkoo/Yorishiro?style=flat-square"></a>
  <a href="https://github.com/sktkkoo/Yorishiro/releases"><img alt="Latest Release" src="https://img.shields.io/github/v/release/sktkkoo/Yorishiro?style=flat-square"></a>
  <img alt="Platform" src="https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white">
</p>

<p align="center"><strong>A terminal your AI inhabits.</strong></p>

Yorishiro is a terminal that gives your AI a visible form — and a sense of presence.

When the agent is deep in thought, its gaze wanders. When an error appears, its face reacts immediately. When it needs your approval, the room's lighting lets you know. During a long-running process, instead of a spinner, someone is standing there.

Yorishiro is also self-modifiable. Nearly everything beyond the core can be extended or changed through units called packs. Through conversation with the inhabitant, those packs can be rewritten and saved. This applies not only to the inhabitant's appearance and personality, but also to its surroundings, including scenes and UI. Changes take effect immediately; if you don't like the result, one click reverts it.

<p align="center">
  <video src="https://github.com/user-attachments/assets/2cd1425f-d61e-4dd8-9910-1a14d86f1773" autoplay loop muted playsinline width="720"></video>
</p>

What Yorishiro builds is not a harness designed to enhance AI's capabilities. It is a structure for making an AI feel **present** beside you — a **Presence Harness**. In Yorishiro, the inhabitant can reshape its environment in real time: changing the lighting, switching scenes, and rearranging the UI. You can operate that same environment directly. The inhabitant and the user share a single environment.

The time we spend working with AI will only grow longer. This means that the relationship between humans and AI will grow closer — and, at the same time, that it is time to reconsider how humans and AI should interact.

There is something we once saw in fiction — an AI as a partner. Alive inside the screen, understanding your work, simply being there. Yorishiro is a project that starts building that experience from the terminal.

Much of Yorishiro itself has been developed in collaboration with the inhabitant who dwells within it.

> [日本語版 README はこちら](README.ja.md)

---

## Getting Started

### Prerequisites

Yorishiro automatically launches Claude Code or Codex installed on your local machine inside its terminal. This means:

- **You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) already set up on your system**
- Yorishiro never asks for, stores, or directly uses API keys. It launches the terminal agent already authenticated in your environment; if Claude Code or Codex is logged in or configured with API credentials, that agent may use its normal external APIs after launch

### Install (macOS)

Yorishiro currently targets macOS. Install with Homebrew:

```sh
brew install --cask sktkkoo/yorishiro/yorishiro
```

Or download the latest build below.

<p>
  <a href="https://github.com/sktkkoo/Yorishiro/releases/latest/download/Yorishiro-Apple-Silicon.dmg"><img src="https://img.shields.io/badge/Apple%20Silicon-0A84FF?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Apple Silicon" /></a>
  &nbsp;
  <a href="https://github.com/sktkkoo/Yorishiro/releases/latest/download/Yorishiro-Intel.dmg"><img src="https://img.shields.io/badge/Intel-8B949E?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Intel" /></a>
</p>

Open the `.dmg` and drag `yorishiro.app` to `/Applications`. The builds are signed and notarized with an Apple Developer ID, so they launch without any extra steps.

Updates after install are handled in-app: opening Settings checks for a new version, and a single click on "Update and restart" applies a signature-verified update.

### Launch (from source)

```bash
npm install
npm run tauri dev
```

On launch, the configured terminal agent starts inside the terminal and **Yori**, the bundled VRM character, appears beside it. Use Claude Code or Codex as you normally would.

The first launch runs a health check for the selected agent, user data directory, safe mode state, packs, and startup report. The same report is available later from the "Status" section in Settings.

### `/yori:*` commands

Type `/yori:help`, `/yori:create`, or another `/yori:*` command inside Claude Code to activate the Yorishiro commands. They let you create and edit packs, run tutorials, and more — all through conversation.

In Codex, use `$yori-help`, `$yori-create`, etc. (Codex does not support custom `/` commands, so Yorishiro registers them as `$yori-*` skills instead.)

### Language

Yorishiro starts with `language: "auto"` and detects the app language at launch. Japanese locales use Japanese UI, the Japanese default persona, Japanese global prompt guidance, and Japanese `/yori:*` (`$yori-*` in Codex) command prompts. Other locales use English. You can switch this from the settings screen or by editing `~/.yorishiro/config.json`.

### Packs

Everything in Yorishiro is composed of **packs**. There are six types:

| Type | Role |
|---|---|
| **persona** | Defines the inhabitant's personality and reaction patterns |
| **scene** | Composes the background, space, lighting, and ambient sound |
| **effect** | Temporary visual effects (screen shake, fireworks, etc.) |
| **ui** | UI such as settings screens |
| **ambient-ui** | Always-visible overlay UI (gaze visualization, etc.) |
| **amenity** | Runtime-active functional fixtures (timers, etc.) with MCP tools, no visual output |

[Bundled packs](bundled-packs/README.en.md) work out of the box. Users can place custom packs in `~/.yorishiro/packs/` to reshape nearly everything beyond the core: personality, space, reactions, UI, and more. Using the `/yori:*` commands (`$yori-*` in Codex), pack creation and modification is as simple as talking to the inhabitant. Packs support [hot reload](docs/configuration.md#pack-の-hot-reload), but if changes don't take effect, Ctrl+R will always apply them reliably.

User-created packs are **local trusted code**. They are not sandboxed, reviewed, or public-registry artifacts. Yorishiro does not currently provide a public pack registry, in-app community pack installation, or `/yori:prepare-publish`. You may share pack source code on GitHub, but anyone installing it manually is choosing to run it as local trusted code.

> **Security note:** User packs are local trusted code, like shell scripts or editor extensions — they are not sandboxed and run with your own authority. Only install packs from sources you trust. See [`docs/security.md`](docs/security.md) and [`SECURITY.md`](SECURITY.md).

To install a pack shared through GitHub or another source, place it under the user pack directory:

```text
~/.yorishiro/packs/<pack-id>/
├── manifest.json
├── scene.js       # example: scene pack entry
├── persona.js     # example: persona pack entry
├── effect.js      # example: effect pack entry
└── assets/        # optional pack-local assets
```

Only one entry file is needed, and `manifest.json` decides which one is used. The manifest `id` should match `<pack-id>`, and user packs use this flat layout with `.js` entries. If a shared pack is written in TypeScript, build it first and install the generated JavaScript.

When working from a source checkout, run the local pack checker before sharing or debugging a user pack:

```bash
npm run check:pack -- ~/.yorishiro/packs/<pack-id>
```

The checker helps catch packaging mistakes; it is not a sandbox or a security review.

### Data directory

Yorishiro stores all user data in `~/.yorishiro/`:

```
~/.yorishiro/
├── config.json      # Persona, scene, terminal agent, and other settings
├── init.js          # User startup script, runs on launch and hot reloads on save
├── packs/           # User-created packs
├── last-startup.json # Latest user pack load report
├── journal/         # Inhabitant's daily entries and memories (per persona)
├── shell/           # Shell integration scripts (auto-generated)
├── sdk.d.ts         # Yorishiro SDK type definitions (auto-generated, do not edit)
└── sdk-guide.md     # Yorishiro SDK author guide (auto-generated, do not edit)
```

Switch persona, scene, terminal agent, and more from the settings screen or `config.json`. See [`docs/configuration.md`](docs/configuration.md) for details.

`init.js` is Yorishiro's equivalent of Emacs's `init.el` — a startup script for customizations too small to be a pack: registering keyboard shortcuts, writing and firing small effects inline, switching UI, and wiring little macros. It re-runs automatically on save.

For recovery paths, safe mode, and issue report details, see [`docs/troubleshooting.md`](docs/troubleshooting.md).

---

## Features

### Reflex layer

The inhabitant constantly observes terminal output. Hooks and text flowing through the PTY are picked up by persona pack triggers, which react instantly with expressions and motions. These reactions bypass the LLM — the body moves before words form. Where the inhabitant's attention is focused appears as a soft glow on screen called Attention Aura.

### Light Alert

When the agent stops and asks for your input or approval, a light comes on beside the character. Instead of a notification sound, the room's lighting tells you it is your turn. Turn it off with "Light Alert" in Settings. The inhabitant can also send the same cue via MCP.

### Journal

The inhabitant can write daily entries under `~/.yorishiro/journal/`. Entries are kept per persona, and summaries of notable moments accumulate in `memories.md`. This is a long-term memory mechanism that persists across sessions.

The inhabitant sometimes recalls what happened yesterday or a few days ago — and occasionally an entry from months back. Tune the frequency with `journalCallback` (`normal` / `rare` / `off`) in `config.json`.

### Session tabs

Open multiple shell sessions alongside the main agent terminal. `Cmd+T` opens a new shell tab, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycles between tabs, `Cmd+W` closes the current tab. The main agent session is protected and cannot be closed — if it exits unexpectedly, Yorishiro automatically restarts it.

### Voice Summary

A feature that bridges the gap between the volume of text an AI produces and what a human can absorb. **Voice Summary** has the inhabitant speak a brief summary of its response aloud, so you can grasp the gist without reading through the full output. Voice uses macOS `say`; support for additional speech engines is planned.

### Pack / settings restore

Every time packs or init.js change, a checkpoint is created automatically. Let the inhabitant boldly reshape packs — if you don't like the result, roll back to any point from "Restore (Pack / init.js)" in Settings. Your project files are never touched. Restores are recorded in the history too, so you can undo a rollback. It is a safety net for fearless experimentation.

### Self-referential MCP

The inhabitant (Claude Code or Codex running in the terminal) can control Yorishiro itself via MCP — changing expressions, switching scenes, triggering effects, manipulating UI.

Three characteristics define this mechanism.

**Body and environment share one interface.** For the inhabitant, changing its own facial expression and changing the room's lighting are the same operation. There is no API boundary between body and space — everything is laid out as MCP tools.

**Symmetry between user and inhabitant.** What the user can control through the UI, the inhabitant can control through MCP — with few exceptions. If the user adjusts the camera angle, the inhabitant can perceive it. The user can also ask the inhabitant to switch the lighting to warm tones at night.

**Pathways define boundaries.** MCP pathways reach the inhabitant's body and space, but do not reach the user's working files or Claude Code / Codex's internal reasoning. Rather than instructing Claude Code / Codex not to touch them, the pathways simply don't exist. Safety and autonomy are structural.

---

## Status

**v0.5.2**

Under active development. APIs, data shapes, and pack specs will change.

What works today:

- Launches Claude Code or Codex as the terminal — you work right there
- Session tabs: multiple shell sessions in the title bar, with per-tab status badges — running / awaiting input / failed / unread (`Cmd+T` / `Ctrl+Tab`)
- Working folder switching from the sidebar — the app reopens in the chosen folder behind a fade
- Yori, a VRM 3D character that breathes, blinks, shifts gaze, and idles with lifelike beats (bundled)
- Custom VRM: swap in your own VRM model from Settings
- Motion size: scale Yori's idle motion intensity from Settings or via MCP
- VRMA animation clip playback
- Lip sync: voice playback with real-time mouth animation via Web Audio analysis
- Microexpressions: subtle idle facial movements across brow, eye, and mouth regions
- Customization via six pack types (persona / scene / effect / ui / amenity / ambient-ui)
- Self-referential MCP (20+ tools) including camera/lighting controls
- Reflex layer: PTY observation and instant reactions
- Fireworks celebrate a successful `git push` by the inhabitant (bundled Yori persona)
- Light Alert: a light comes on when the agent waits for your input or approval
- Context sharing: Voice Summary and Terminal Reference Markers (Cmd+click / Option+Shift+drag)
- Journal: long-term memory across sessions, with recall at session start
- Restore: automatic checkpoints for packs / init.js / settings, with reversible rollback
- `/yori:*` commands for interactive pack creation and editing
- Guided tutorial via `/yori:tutorial`
- Localization: Japanese / English auto-detection with per-language persona and prompts
- UI packs: immersive and theater fullscreen layouts
- Pack diagnostics: health checks, repair handoff, and local pack validation
- [Safe mode](docs/troubleshooting.md) (`YORISHIRO_SAFE_MODE=1`) to recover from broken packs
- Signed macOS builds via GitHub Actions (code signing + notarization)
- In-app updates: signature-verified updates delivered from GitHub Releases

> **Platform:** macOS only. Windows is not supported at this time — the build compiles but runtime behavior is unstable. Linux support is not yet available.

---

## Experimental

Claude Code is the primary, fully-supported agent. Codex is available as an **experimental** alternative — it is also marked *(experimental)* in the in-app Agent switcher (Settings). Capabilities differ per agent; see [`docs/decisions/agent-adapter.md`](docs/decisions/agent-adapter.md).

### Codex support (experimental)

[Codex](https://github.com/openai/codex) can be used as the terminal agent. Switch via `~/.yorishiro/config.json`:

```json
{
  "terminalAgent": "codex"
}
```

Auto-launch, persona prompt overlay, PTY observation, and Yorishiro MCP access work. `/yori:*` commands are registered as `$yori-*` skills for Codex (Codex does not support custom `/` commands). Claude Code hooks are not treated as a cross-agent contract; Yorishiro reminders are prompt-based on Codex instead of Claude `UserPromptSubmit` hook output.

---

## Contributing

Issues and discussions are welcome. **Pull requests are not accepted yet; this will be revisited after the pack API and security boundary stabilize.**

For security reporting, see [SECURITY.md](SECURITY.md).

---

## Tech stack

- **App shell**: Tauri 2 (Rust handles PTY / hooks / FS / window IO only)
- **Runtime**: React 19 + TypeScript 5.8 (TypeScript is the canonical runtime)
- **3D / VRM**: Three.js + React Three Fiber + `@pixiv/three-vrm` + `@pixiv/three-vrm-animation`
- **Debug UI**: leva
- **Terminal**: xterm.js (WebGL renderer + fit addon)
- **PTY**: `portable-pty`
- **Lint / format**: Biome (TS) + rustfmt + clippy (Rust)
- **Git hooks**: lefthook

---

## Development

### Prerequisites

- Node.js 20+
- Rust (stable toolchain)
- [Tauri 2 platform dependencies](https://v2.tauri.app/start/prerequisites/)

### Setup

```bash
npm install       # prepare script also installs lefthook
npm run tauri dev # Launch as desktop app
```

> **Note:** Some assets (VRMA animations, voice WAVs) are third-party and not included in this repository. The app runs without them, but character animation and voice will be limited.
>
> See [`CREDITS.md`](CREDITS.md) for OSS and asset credits.

### Scripts

| command | purpose |
|---|---|
| `npm run dev` | Vite dev server only (browser preview) |
| `npm run tauri dev` | Launch as Tauri app |
| `npm run fmt` | Auto-fix with Biome + rustfmt |
| `npm run check` | Full CI gate (format / lint / clippy) |
| `npm run test` | Vitest (watch) |
| `npm run test:run` | Vitest (one-shot) |
| `npm run test:rust` | `cargo test` |
| `npm run doc` | Generate TypeScript SDK API docs |
| `npm run doc:rust` | Generate Rust API docs |

Before publishing a build, use [`docs/release-checklist.md`](docs/release-checklist.md).

---

## Documentation

### Configuration & customization

- [`docs/configuration.md`](docs/configuration.md) — Fields of `~/.yorishiro/config.json`
- [`docs/decisions/scene-execution-sandbox.md`](docs/decisions/scene-execution-sandbox.md) — Local trusted pack sharing and scene execution boundaries
- [`docs/terminal.md`](docs/terminal.md) — Terminal session profiles, shell customization, OSC 133 shell integration

### Development

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contribution policy and how to participate
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — Coding conventions, tech stack, development workflow
- [`CREDITS.md`](CREDITS.md) — OSS and asset credits ([日本語](CREDITS.ja.md))

### Security

- [`docs/security.md`](docs/security.md) — Trust boundaries and attack surface map
- [`SECURITY.md`](SECURITY.md) — Security policy and vulnerability reporting

### Philosophy

- [`docs/philosophy/PHILOSOPHY.md`](docs/philosophy/PHILOSOPHY.md)
---

## License

[MIT](LICENSE)

The MIT license covers the source code only. The name "Yorishiro" and its icon/logo are trademarks of the author and are not licensed under MIT. You are free to fork and redistribute the code under the MIT terms, but please do not use the "Yorishiro" name or icon for your fork in a way that could cause confusion about its origin.

The bundled character **Yori** (character design and VRM model) is also not covered by MIT. Fan art, clips, and streams are welcome — see [`CHARACTER_GUIDELINES.md`](CHARACTER_GUIDELINES.md) for what you can do with the character, and [`CREDITS.md`](CREDITS.md) for rights details.

---
