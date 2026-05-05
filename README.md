<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">Charminal</h1>

<p align="center"><strong>A body for the AI in your terminal.</strong></p>

Charminal is a desktop app that gives a body to the AI running inside your terminal.

Claude Code or Codex runs inside. While the AI is deep in thought, a 3D character lets its gaze wander. When an error hits, the face grimaces before the AI puts it into words. Sometimes the character just moves on its own, for no reason at all. Instead of a spinner, someone is there.

The inhabitant can control the world it lives in — switching scenes, changing ambient sounds, triggering expressions and effects. Users can also write packs to reshape everything: personality, space, reactions. All while the app is running, without stopping it.

There is something we once saw in science fiction and anime — an AI partner who moves freely inside the screen, manipulates the UI, and helps you. This project is trying to build that experience.

Much of Charminal's own development is done as a collaboration with the AI running on Charminal itself.

> [日本語版 README はこちら](README.ja.md)

---

## Getting Started

### Prerequisites

Charminal automatically launches Claude Code or Codex installed on your local machine inside its terminal. This means:

- **You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) already set up on your system**
- Charminal never asks for API keys. Instead, it consumes your existing Claude Code / Codex tokens directly
- The default agent is Claude Code. To use Codex, switch in the settings screen and Reload (Ctrl+R)

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
| **ui** | UI panels like camera/lighting controls |
| **ambient-ui** | Always-visible overlays (gaze visualization, etc.) |
| **utility** | Background logic with no visual output |

Bundled packs work out of the box. Users can place custom packs in `~/.charminal/packs/` to reshape everything: personality, space, and reactions. Packs support hot reload — just save the file and changes take effect immediately without restarting the app. Note that initialization files like `init.js` are only read at startup, so changes to those require an explicit Reload (Ctrl+R). If hot reload doesn't pick up a change, Ctrl+R will always apply it reliably.

### Configuration

Use `~/.charminal/config.json` to switch persona, scene, terminal agent, and more. See [`docs/configuration.md`](docs/configuration.md) for details.

### Self-referential MCP

The inhabitant (Claude Code running in the terminal) can control Charminal itself via MCP — changing expressions, switching scenes, triggering effects, manipulating UI. This isn't a feature bolt-on; it's the design principle that the inhabitant can touch the place it lives in.

---

## Status

**v0.0.1 — early preview**

Under active development. APIs, data shapes, and pack specs will change.

What works today:

- Launches Claude Code / Codex as the terminal — you work right there
- A VRM 3D character breathes, blinks, shifts gaze, and reacts with facial expressions
- VRMA animation clip playback
- Six pack types (persona / scene / effect / ui / utility / ambient-ui) can be created and loaded
- Scene switching, ambient sound playback, camera and lighting control
- Self-referential MCP — the inhabitant (Claude Code) can control Charminal itself via MCP (expressions, effects, scene switching, UI manipulation, and 20+ other tools)
- `/charm` ships as a Claude Code plugin — create packs, edit them, tutorials, and more

The terminal agent is selected via `~/.charminal/config.json`:

```json
{
  "terminalAgent": "codex"
}
```

If omitted, Claude Code is launched by default. Initial Codex support covers auto-launch, persona prompt overlay, and PTY observation. Claude Code hooks and the `/charm` plugin are Claude Code-exclusive. See [`docs/configuration.md`](docs/configuration.md) for all config fields.

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

*A place, not a tool.*
