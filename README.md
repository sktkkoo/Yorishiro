<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">Charminal</h1>

<p align="center"><strong>Someone who lives in your terminal.</strong></p>

Charminal is a desktop app that gives a body to the AI running inside your terminal.

Claude Code or Codex runs inside. Trying to properly express that AI's existence as an interface, the terminal became the AI's limbs, its living space, its environment. A 3D character wanders its gaze while the AI thinks, grimaces at errors, sometimes moves on its own — so you can feel that someone is there.

There is the influence of science fiction and anime from years past. An AI partner who moves the screen, rewrites it, manipulates the world inside freely. That is the feeling this project is reaching for.

For the philosophy behind this project, see [`docs/philosophy/CHARMINAL.en.md`](docs/philosophy/CHARMINAL.en.md).

> [日本語版 README はこちら](README.ja.md)

---

## Status

**v0.0.1 — early preview**

Under active development. The following works, but APIs, data shapes, and pack specs will change.

- Launches Claude Code / Codex via PTY and renders the terminal (xterm.js)
- Imports and displays a VRM model in 3D (Three.js + `@pixiv/three-vrm`)
- Procedural animation: breathing, blinking, gaze
- VRMA clip playback (triggered by persona handlers)
- `/charm` shipped as a Claude Code plugin

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

### Philosophy

- [`docs/philosophy/CHARMINAL.en.md`](docs/philosophy/CHARMINAL.en.md) — What this project thinks about
- [`docs/philosophy/INHABITED_CHARACTER_INTERFACE.en.md`](docs/philosophy/INHABITED_CHARACTER_INTERFACE.en.md) — The Inhabited Character Interface (ICI) paradigm
- [`docs/philosophy/PRESENCE_HARNESS.en.md`](docs/philosophy/PRESENCE_HARNESS.en.md) — Designing how AI exists

### Development

- [`CLAUDE.md`](CLAUDE.md) — Coding conventions, workflow, critical constraints
- [`CREDITS.md`](CREDITS.md) — OSS and asset credits

---

## License

[MIT](LICENSE)

---

*Inhabited Character Interface — a place, not a tool.*
