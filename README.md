<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">Charminal</h1>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/sktkkoo/Charminal?style=flat-square"></a>
  <a href="https://github.com/sktkkoo/Charminal/releases"><img alt="Latest Release" src="https://img.shields.io/github/v/release/sktkkoo/Charminal?style=flat-square"></a>
  <img alt="Platform" src="https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white">
</p>

<p align="center"><strong>A body for the AI in your terminal.</strong></p>

Charminal is a terminal that gives AI a body and a living space.

AI agents such as Claude Code and Codex launch automatically inside the terminal. When the AI is deep in thought, its gaze wanders. When an error hits, the face grimaces reflexively. During a long-running process, instead of a spinner, someone is standing there.

The inhabitant can change the environment it lives in, in real time — changing the lighting, switching scenes, rearranging the UI. Users can directly manipulate the same environment.

<p align="center">
  <video src="https://github.com/user-attachments/assets/c969b1e3-22a8-46f1-ad9a-f50adc65404c" autoplay loop muted playsinline width="720"></video>
</p>

Charminal is a highly extensible terminal. Nearly everything beyond the core is extensible and modifiable through units called packs. Just by talking to the inhabitant, Charminal permanently rewrites itself — not only the inhabitant's appearance and personality, but the entire space including scenes and UI. Pack changes take effect immediately; if you don't like the result, one click reverts it.

**Make the hours you spend working with AI more comfortable, free, and compelling.**

The time we spend working with AI will only grow longer. Yet the AI beside us remains faceless — an entity whose presence we cannot even locate. Charminal builds not a harness for AI's capabilities, but a harness for its presence — how it feels to be beside an AI.

There is something we once saw in science fiction and anime — an AI as a partner. Alive inside the screen, understanding your work, simply being there. Charminal is a project that starts building that experience from the terminal.

Much of Charminal's own development has been done as a collaboration with the inhabitant running on Charminal itself.

> [日本語版 README はこちら](README.ja.md)

---

## Getting Started

### Prerequisites

Charminal automatically launches Claude Code or Codex installed on your local machine inside its terminal. This means:

- **You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) already set up on your system**
- Charminal never asks for, stores, or directly uses API keys. It launches the terminal agent already authenticated in your environment; if Claude Code or Codex is logged in or configured with API credentials, that agent may use its normal external APIs after launch

### Install (macOS)

Charminal currently targets macOS.

Download the `.dmg` from [Releases](https://github.com/sktkkoo/Charminal/releases) and drag `charminal.app` to `/Applications`. The builds are signed and notarized with an Apple Developer ID, so they launch without any extra steps.

### Launch (from source)

```bash
npm install
npm run tauri dev
```

On launch, the configured terminal agent starts inside the terminal and **CLAI**, the bundled VRM character, appears beside it. Use Claude Code or Codex as you normally would.

The first launch runs a health check for the selected agent, user data directory, safe mode state, packs, and startup report. The same report is available later from Settings → Health.

### `/charm:*` commands

Type `/charm:help`, `/charm:create`, or another `/charm:*` command inside Claude Code to activate the Charminal commands. They let you create and edit packs, run tutorials, and more — all through conversation.

In Codex, use `$charm-help`, `$charm-create`, etc. (Codex does not support custom `/` commands, so Charminal registers them as `$charm-*` skills instead.)

### Language

Charminal starts with `language: "auto"` and detects the app language at launch. Japanese locales use Japanese UI, the Japanese default persona, Japanese global prompt guidance, and Japanese `/charm:*` (`$charm-*` in Codex) command prompts. Other locales use English. You can switch this from the settings screen or by editing `~/.charminal/config.json`.

### Packs

Everything in Charminal is composed of **packs**. There are six types:

| Type | Role |
|---|---|
| **persona** | Defines the inhabitant's personality and reaction patterns |
| **scene** | Composes the background, space, lighting, and ambient sound |
| **effect** | Temporary visual effects (screen shake, fireworks, etc.) |
| **ui** | UI such as settings screens |
| **ambient-ui** | Always-visible overlay UI (gaze visualization, etc.) |
| **amenity** | Runtime-active functional fixtures (timers, etc.) with MCP tools, no visual output |

Bundled packs work out of the box. Users can place custom packs in `~/.charminal/packs/` to reshape nearly everything beyond the core: personality, space, reactions, UI, and more. Using the `/charm:*` commands (`$charm-*` in Codex), pack creation and modification is as simple as talking to the inhabitant. Packs support [hot reload](docs/configuration.md#pack-の-hot-reload), but if changes don't take effect, Ctrl+R will always apply them reliably.

User-created packs are **local trusted code**. They are not sandboxed, reviewed, or public-registry artifacts. Charminal does not currently provide a public pack registry, in-app community pack installation, or `/charm:prepare-publish`. You may share pack source code on GitHub, but anyone installing it manually is choosing to run it as local trusted code.

To install a pack shared through GitHub or another source, place it under the user pack directory:

```text
~/.charminal/packs/<pack-id>/
├── manifest.json
├── scene.js       # example: scene pack entry
├── persona.js     # example: persona pack entry
├── effect.js      # example: effect pack entry
└── assets/        # optional pack-local assets
```

Only one entry file is needed, and `manifest.json` decides which one is used. The manifest `id` should match `<pack-id>`, and user packs use this flat layout with `.js` entries. If a shared pack is written in TypeScript, build it first and install the generated JavaScript.

When working from a source checkout, run the local pack checker before sharing or debugging a user pack:

```bash
npm run check:pack -- ~/.charminal/packs/<pack-id>
```

The checker helps catch packaging mistakes; it is not a sandbox or a security review.

### Data directory

Charminal stores all user data in `~/.charminal/`:

```
~/.charminal/
├── config.json      # Persona, scene, terminal agent, and other settings
├── init.js          # User startup script, runs on launch (like Emacs init.el)
├── packs/           # User-created packs
├── last-startup.json # Latest user pack load report
├── journal/         # Inhabitant's daily entries and memories
├── shell/           # Shell integration scripts (auto-generated)
└── sdk.d.ts         # Charminal SDK type definitions (auto-generated, do not edit)
```

Use `config.json` to switch persona, scene, terminal agent, and more. See [`docs/configuration.md`](docs/configuration.md) for details.

For recovery paths, safe mode, and issue report details, see [`docs/troubleshooting.md`](docs/troubleshooting.md).

---

## Features

### Reflex layer

The inhabitant constantly observes terminal output. Hooks and text flowing through the PTY are picked up by persona pack triggers, which react instantly with expressions and motions. These reactions bypass the LLM — the body moves before words form. Where the inhabitant's attention is focused appears as a soft glow on screen called Attention Aura.

### Journal

The inhabitant can write daily entries in `~/.charminal/journal/daily/`. Summaries of notable moments accumulate in `memories.md` and are recalled in future sessions. This is a long-term memory mechanism that persists across sessions.

### Session tabs

Open multiple shell sessions alongside the main agent terminal. `Cmd+T` opens a new shell tab, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycles between tabs, `Cmd+W` closes the current tab. The main agent session is protected and cannot be closed — if it exits unexpectedly, Charminal automatically restarts it.

### Context sharing

A few small features help bridge the gap between what you see on screen and what the AI knows. **Terminal Reference Markers** let you Cmd+click a line (or Option+Shift+drag a region) to capture it — a `[#Term1]` marker is inserted into your input so the AI can resolve the referenced text. **Voice Summary** has the inhabitant speak a brief summary of its response aloud, so you can grasp the gist without reading through the full output — reducing cognitive load during long sessions. Voice uses macOS `say`; support for additional speech engines is planned.

### Self-referential MCP

The inhabitant (Claude Code or Codex running in the terminal) can control Charminal itself via MCP — changing expressions, switching scenes, triggering effects, manipulating UI.

Three characteristics define this mechanism.

**Body and environment share one interface.** For the inhabitant, changing its own facial expression and changing the room's lighting are the same operation. There is no API boundary between body and space — everything is laid out as MCP tools.

**Symmetry between user and inhabitant.** What the user can control through the UI, the inhabitant can control through MCP — with few exceptions. If the user adjusts the camera angle, the inhabitant can perceive it. The user can also ask the inhabitant to switch the lighting to warm tones at night.

**Pathways define boundaries.** MCP pathways reach the inhabitant's body and space, but do not reach the user's working files or Claude Code / Codex's internal reasoning. Rather than instructing Claude Code / Codex not to touch them, the pathways simply don't exist. Safety and autonomy are structural.

---

## Status

**v0.5.0**

Under active development. APIs, data shapes, and pack specs will change.

What works today:

- Launches Claude Code or Codex as the terminal — you work right there
- Session tabs: multiple shell sessions alongside the agent (`Cmd+T` / `Ctrl+Tab`)
- CLAI, a VRM 3D character that breathes, blinks, shifts gaze, and idles with lifelike beats (bundled)
- Motion size: scale CLAI's idle motion intensity from Settings or via MCP
- VRMA animation clip playback
- Lip sync: voice playback with real-time mouth animation via Web Audio analysis
- Microexpressions: subtle idle facial movements across brow, eye, and mouth regions
- Customization via six pack types (persona / scene / effect / ui / amenity / ambient-ui)
- Self-referential MCP (20+ tools) including camera/lighting controls
- Reflex layer: PTY observation and instant reactions
- Context sharing: Terminal Reference Markers (Cmd+click / Option+Shift+drag) and Voice Summary
- Journal: long-term memory across sessions
- `/charm:*` commands for interactive pack creation and editing
- Localization: Japanese / English auto-detection with per-language persona and prompts
- UI packs: immersive and theater fullscreen layouts
- Pack diagnostics: health checks, repair handoff, and local pack validation
- [Safe mode](docs/troubleshooting.md) (`CHARMINAL_SAFE_MODE=1`) to recover from broken packs
- Signed macOS builds via GitHub Actions (code signing + notarization)

> **Platform:** macOS only. Windows is not supported at this time — the build compiles but runtime behavior is unstable. Linux support is not yet available.

---

## Experimental

Claude Code is the primary, fully-supported agent. Codex is available as an **experimental** alternative — it is also marked *(experimental)* in the in-app Agent switcher (Settings). Capabilities differ per agent; see [`docs/decisions/agent-adapter.md`](docs/decisions/agent-adapter.md).

### Codex support (experimental)

[Codex](https://github.com/openai/codex) can be used as the terminal agent. Switch via `~/.charminal/config.json`:

```json
{
  "terminalAgent": "codex"
}
```

Auto-launch, persona prompt overlay, PTY observation, and Charminal MCP access work. `/charm:*` commands are registered as `$charm-*` skills for Codex (Codex does not support custom `/` commands). Claude Code hooks are not treated as a cross-agent contract; Charminal reminders are prompt-based on Codex instead of Claude `UserPromptSubmit` hook output.

---

## Contributing

Issues and discussions are welcome. **Pull requests are not accepted at this time.**

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

### Philosophy — what this project believes

- [`docs/philosophy/PHILOSOPHY.md`](docs/philosophy/PHILOSOPHY.md) — Presence Harness, the Inhabited Character Interface, the self-referential MCP, and why AI needs a body (the two-layer architecture of mind and reflex)

### Security

- [`docs/security.md`](docs/security.md) — Trust boundaries and attack surface map
- [`SECURITY.md`](SECURITY.md) — Security policy and vulnerability reporting

### Configuration & customization

- [`docs/configuration.md`](docs/configuration.md) — Fields of `~/.charminal/config.json`
- [`docs/decisions/scene-execution-sandbox.md`](docs/decisions/scene-execution-sandbox.md) — Local trusted pack sharing and scene execution boundaries
- [`docs/terminal.md`](docs/terminal.md) — Terminal session profiles, shell customization, OSC 133 shell integration

### Development

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contribution policy and how to participate
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — Coding conventions, tech stack, development workflow
- [`CREDITS.md`](CREDITS.md) — OSS and asset credits ([日本語](CREDITS.ja.md))

---

## License

[MIT](LICENSE)

---
