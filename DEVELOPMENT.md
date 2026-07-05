# Development Guide

Local development guide for Yorishiro.

---

## Tech Stack

Tauri 2 + React 19 + TypeScript 5.8 + Three.js + @pixiv/three-vrm + xterm.js

- **TypeScript**: canonical runtime (cognition, reflexes, body, UI — everything)
- **Rust**: IO layer only (PTY / hooks / FS / window)

## Getting Started

```bash
# Prerequisites: Node.js 20+, Rust stable, Tauri CLI v2
npm install
npm run tauri dev    # dev server (port 1430)
```

## Coding Conventions

### Directory naming

- **TypeScript (`src/`)**: `kebab-case` for directories. Files inside can be camelCase (`logBridge.ts`) or kebab-case (`log-bridge.ts`)
- **Rust (`src-tauri/src/`)**: `snake_case` for directories and `.rs` files (enforced by rustc per RFC 430)

TS and Rust mirror each other 1:1 in structure, but follow their respective language idioms for naming.

| concept | TS path | Rust path |
|---|---|---|
| LogBridge | `src/core/log-bridge/` | `src-tauri/src/core/log_bridge/` |
| TwoLayer | `src/core/two-layer/` | `src-tauri/src/core/two_layer/` |
| BodyScheduler | `src/runtime/body-scheduler/` | `src-tauri/src/runtime/body_scheduler/` |

### Identifier naming

- TypeScript: `PascalCase` for types/classes/interfaces, `camelCase` for functions/variables, `SCREAMING_SNAKE_CASE` for constants
- Rust: `PascalCase` for types, `snake_case` for functions/variables/fields, `SCREAMING_SNAKE_CASE` for constants (RFC 430)

### Comments / docstrings

Write comments and docstrings in **Japanese**. Keep identifiers and code examples in their target language.

## Linting & Formatting

- **TS**: Biome (formatter + linter + import organizer, all-in-one)
- **Rust**: rustfmt ([official Style Guide](https://doc.rust-lang.org/style-guide/)) + clippy (gated with `-D warnings`)

| command | purpose |
|---|---|
| `npm run fmt` | auto-fix (Biome --write + cargo fmt) |
| `npm run check` | read-only verification (CI equivalent) |
| `npm run lint` | lint only |
| `npm run test:run` | TS tests (vitest) |
| `npm run test:rust` | Rust tests (cargo test) |
| `npm run doc` | API doc generation (typedoc → `docs/api/typescript/`) |
| `npm run doc:rust` | Rust API doc generation (cargo doc) |

Git hooks (lefthook) are installed automatically via `npm install`.

- **pre-commit**: lightweight fix on staged files
- **pre-push**: full gate (`biome check` / `cargo fmt --check` / `cargo clippy -- -D warnings` / typedoc validation)

> Directory / identifier naming is not enforced by linters (Biome's `useFilenamingConvention` is intentionally disabled). Follow the conventions manually.

## Development Workflow

Feature work uses **git worktree**. Keep the primary directory as a shared baseline on `main`, and branch off a worktree per feature.

```bash
# Create a worktree
git worktree add ../Yorishiro-<feature> -b feat/<feature>
cd ../Yorishiro-<feature>
npm install  # each worktree has its own node_modules

# When done
cd <repo-root>/Yorishiro
git merge feat/<feature>
git worktree remove ../Yorishiro-<feature>
git branch -d feat/<feature>
```

Cases where working directly on `main` (without a worktree) is acceptable:

- Single-file, single-line typo fixes
- No parallel work in progress

## Documentation

### Structure

| Layer | Location | Content | Audience |
|---|---|---|---|
| Navigation | `docs/README.md` + per-directory `README.md` | pointer collection (drift-resistant) | everyone |
| Public philosophy | `docs/philosophy/` | project manifestos and principles | anyone visiting the repo |
| Decisions / constraints | `docs/decisions/` | topic-indexed design decisions and rationale | dev / contributor |
| In-code README | `src/README.md`, `src-tauri/README.md`, etc. | architecture overview | dev / contributor |
| Auto-generated | `docs/api/` (`.gitignore`d) | typedoc / cargo doc output | dev |

Start navigation from [`docs/README.md`](docs/README.md).

### Design decisions

For detailed design decisions, see [`docs/decisions/`](docs/decisions/). Critical design boundaries are consolidated in [`docs/decisions/critical-constraints.md`](docs/decisions/critical-constraints.md).

### Doc sync rules (on code changes)

| Code change | Update target | Skippable? |
|---|---|---|
| New directory under `src/<top-level>/` | The relevant cluster README + architecture map in `docs/README.md` | ❌ required |
| New module under `src-tauri/src/` | `src-tauri/README.md` + `docs/README.md` | ❌ required |
| New design decision finalized / existing decision revised | Create or append revision history in `docs/decisions/<topic>.md` | ❌ required |
| Pack type / registry semantic changes | `bundled-packs/README.md` + `src/runtime/README.md` | ❌ required |
| Individual file API / docstring changes | Not needed (`npm run doc` regenerates fresh output) | ✅ skip |
| Bug fix / internal implementation changes | Not needed (commit message is the source of truth) | ✅ skip |

## Pack Development

For how to write packs, see [`src/sdk/README.md`](src/sdk/README.md). Bundled packs ([`bundled-packs/`](bundled-packs/)) serve as reference implementations.

User-created packs are treated as local trusted code. There is no public registry, no in-app community install, and no `/yori:prepare-publish`, so do not describe `/yori:create` output as sandboxed, reviewed, or publicly distributable artifacts.

To inspect a user pack from a source checkout:

```bash
npm run check:pack -- ~/.yorishiro/packs/<pack-id>
npm run check:pack -- --mode publish-candidate ~/.yorishiro/packs/<pack-id>
```

`local-authoring` mode is for `/yori:create` output. `publish-candidate` mode is a preview of pre-registry-review checks for the future and is not an official publication gate at this time. The public submission flow does not yet exist, and JS / TS scanning relies on heuristics pending AST implementation.
