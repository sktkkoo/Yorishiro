<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">Charminal</h1>

<p align="center"><strong>A body for the AI in your terminal.</strong></p>

Charminal is a desktop app that gives a body to the AI running inside your terminal.

Claude Code or Codex runs inside. While the AI is deep in thought, a 3D character lets its gaze wander. When an error hits, the face grimaces before the AI puts it into words. Sometimes the character just moves on its own, for no reason at all. Instead of a spinner, someone is there.

The inhabitant can control the world it lives in — switching scenes, triggering expressions and effects. Users can also reshape everything just by talking to the inhabitant: personality, space, reactions. All while the app is running, without stopping it.

There is something we once saw in science fiction and anime — an AI partner who moves freely inside the screen, manipulates the UI, and helps you. This project is trying to build that experience.

Much of Charminal's own development has been done as a collaboration with the AI running on Charminal itself.

> [日本語版 README はこちら](README.ja.md)

---

## Getting Started

### Prerequisites

Charminal automatically launches Claude Code or Codex installed on your local machine inside its terminal. This means:

- **You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) already set up on your system**
- Charminal never asks for API keys. Instead, it consumes your existing Claude Code tokens directly

### Launch

```bash
npm install
npm run tauri dev
```

On launch, Claude Code starts inside the terminal and a VRM character appears beside it. Use Claude Code as you normally would.

### `/charm` command

Type `/charm` inside Claude Code to activate the Charminal plugin. It lets you create and edit packs, run tutorials, and more — all through conversation.

### Packs

Everything in Charminal is composed of **packs**. There are six types:

| Type | Role |
|---|---|
| **persona** | Defines the inhabitant's personality and reaction patterns |
| **scene** | Composes the background, space, lighting, and ambient sound |
| **effect** | Temporary visual effects (screen shake, fireworks, etc.) |
| **ui** | UI such as settings screens |
| **ambient-ui** | Always-visible overlay UI (gaze visualization, etc.) |
| **utility** | Background logic with no visual output |

Bundled packs work out of the box. Users can place custom packs in `~/.charminal/packs/` to reshape nearly everything beyond the core: personality, space, reactions, UI, and more. Using the `/charm` command, pack creation and modification is as simple as talking to the inhabitant. Packs support hot reload — just save the file and changes take effect immediately without restarting the app. Note that initialization files like `init.js` are only read at startup, so changes to those require an explicit Reload (Ctrl+R). If hot reload doesn't pick up a change, Ctrl+R will always apply it reliably.

### Configuration

Use `~/.charminal/config.json` to switch persona, scene, terminal agent, and more. See [`docs/configuration.md`](docs/configuration.md) for details.

---

## Features

### Self-referential MCP

The inhabitant (Claude Code running in the terminal) can control Charminal itself via MCP — changing expressions, switching scenes, triggering effects, manipulating UI.

Three characteristics define this mechanism.

**Body and environment share one interface.** For the inhabitant, changing its own facial expression and changing the room's lighting are the same operation. There is no API boundary between body and space — everything is laid out as MCP tools.

**Symmetry between user and inhabitant.** What the user can control through the UI, the inhabitant can control through MCP — with few exceptions. If the user adjusts the camera angle, the inhabitant can perceive it. If the inhabitant switches the lighting to warm tones at night, the user will notice it the next morning.

**Pathways define boundaries.** MCP pathways reach the inhabitant's body and space, but do not reach the user's working files or Claude Code / Codex's internal reasoning. Rather than instructing Claude Code / Codex not to touch them, the pathways simply don't exist. Safety and autonomy are structural.

### Reflex layer

The inhabitant constantly observes terminal output. Errors, test results, command completions — persona pack triggers pick up text flowing through the PTY and react instantly with expressions and motions. These reactions bypass the LLM; the body moves before words form. Where the inhabitant's attention is focused appears as a soft glow on screen called Attention Aura.

### Journal

The inhabitant can write daily entries in `~/.charminal/journal/daily/`. Summaries of notable moments accumulate in `memories.md` and are recalled in future sessions. This is a long-term memory mechanism that persists across sessions.

---

## Status

**v0.1.0 — early preview**

Under active development. APIs, data shapes, and pack specs will change.

What works today:

- Launches Claude Code as the terminal — you work right there
- A VRM 3D character that breathes, blinks, and shifts gaze
- VRMA animation clip playback
- Customization via six pack types (persona / scene / effect / ui / utility / ambient-ui)
- Self-referential MCP (20+ tools)
- Reflex layer: PTY observation and instant reactions
- Journal: long-term memory across sessions
- `/charm` for interactive pack creation and editing

---

## Experimental

### Codex support

[Codex](https://github.com/openai/codex) can be used as the terminal agent. Switch via `~/.charminal/config.json`:

```json
{
  "terminalAgent": "codex"
}
```

Auto-launch, persona prompt overlay, and PTY observation work. However, Claude Code hooks and the `/charm` plugin are Claude Code-exclusive and not available when using Codex.

---

## Contributing

This is a personal project in active development. Issues and discussions are welcome. **Pull requests are not accepted at this time.**

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

---

## Documentation

### Philosophy — what this project believes

- [`docs/philosophy/INHABITED_CHARACTER_INTERFACE.en.md`](docs/philosophy/INHABITED_CHARACTER_INTERFACE.en.md) — Treating UI as a place and AI as its inhabitant
- [`docs/philosophy/CHARMINAL.en.md`](docs/philosophy/CHARMINAL.en.md) — Why AI needs a body. The two-layer architecture of mind and reflex
- [`docs/philosophy/PRESENCE_HARNESS.en.md`](docs/philosophy/PRESENCE_HARNESS.en.md) — Designing not what AI can do, but how AI exists

### Configuration & customization

- [`docs/configuration.md`](docs/configuration.md) — Fields of `~/.charminal/config.json`
- [`docs/terminal.md`](docs/terminal.md) — Terminal session profiles, shell customization, OSC 133 shell integration

### Development

- [`CLAUDE.md`](CLAUDE.md) — Coding conventions, workflow, critical constraints
- [`CREDITS.md`](CREDITS.md) — OSS and asset credits

---

## License

[MIT](LICENSE)

---
