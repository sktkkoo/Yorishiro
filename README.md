<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">Charminal</h1>

<p align="center"><strong>A body for the AI in your terminal.</strong></p>

Charminal is a desktop app that gives a body to the AI running inside your terminal.

Claude Code or Codex runs inside. While the AI is deep in thought, a 3D character lets its gaze wander. When an error hits, the face grimaces before the AI puts it into words. Sometimes the character just moves on its own, for no reason at all. Instead of a spinner, someone is there.

The inhabitant can control the world it lives in — switching scenes, changing ambient sounds, triggering expressions and effects. Users can also write packs to reshape everything: personality, space, reactions. All while the app is running, without stopping it.

There is something we once saw in science fiction and anime — an AI partner who moves freely inside the screen, manipulates the UI, and helps you. This project is trying to build that experience.

> [日本語版 README はこちら](README.ja.md)

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

- [`docs/philosophy/CHARMINAL.en.md`](docs/philosophy/CHARMINAL.en.md) — Why AI needs a body. The two-layer architecture of mind and reflex
- [`docs/philosophy/INHABITED_CHARACTER_INTERFACE.en.md`](docs/philosophy/INHABITED_CHARACTER_INTERFACE.en.md) — Treating UI as a place and AI as its inhabitant
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
