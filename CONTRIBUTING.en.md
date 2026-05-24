# Contributing to Charminal

Contribution guide for Charminal.

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

Comments and docstrings are written in **Japanese**. Identifiers and code examples remain in their original language.

## Linting & Formatting

- **TS**: Biome (formatter + linter + import organizer, all-in-one)
- **Rust**: rustfmt ([official Style Guide](https://doc.rust-lang.org/style-guide/)) + clippy (`-D warnings` gate)

| Command | Purpose |
|---|---|
| `npm run fmt` | auto-fix (Biome --write + cargo fmt) |
| `npm run check` | read-only verification (CI equivalent) |
| `npm run lint` | lint only |
| `npm run test:run` | TS tests (vitest) |
| `npm run test:rust` | Rust tests (cargo test) |
| `npm run doc` | API doc generation (typedoc → `docs/api/typescript/`) |
| `npm run doc:rust` | Rust API doc generation (cargo doc) |

Git hooks (lefthook) are automatically installed via `npm install`.

- **pre-commit**: lightweight fix on staged files
- **pre-push**: full gate (`biome check` / `cargo fmt --check` / `cargo clippy -- -D warnings` / typedoc validation)

> Directory / Identifier naming is not enforced by linters (Biome's `useFilenamingConvention` is intentionally disabled). Follow the conventions manually.

## Development Workflow

Feature development uses **git worktree**. The main directory serves as a shared baseline on main, with a worktree created per feature.

```bash
# Create worktree
git worktree add ../Charminal-<feature> -b feat/<feature>
cd ../Charminal-<feature>
npm install  # each worktree has its own node_modules

# When done
cd <repo-root>/Charminal
git merge feat/<feature>
git worktree remove ../Charminal-<feature>
git branch -d feat/<feature>
```

Cases where working directly on main without a worktree is acceptable:

- Single-file, single-line typo fixes
- No parallel work in progress

## Documentation

### Structure

| Layer | Location | Content | Audience |
|---|---|---|---|
| Navigation | `docs/README.md` + per-directory `README.md` | pointer collection (drift-resistant) | Everyone |
| Public philosophy | `docs/philosophy/` | project manifestos and principles | Anyone visiting the repo |
| Decisions / constraints | `docs/decisions/` | topic-indexed design decisions and rationale | dev / contributor |
| In-code README | `src/README.md`, `src-tauri/README.md`, etc. | architecture overview | dev / contributor |
| Auto-generated | `docs/api/` (`.gitignore`d) | typedoc / cargo doc output | dev |

Start navigating from [`docs/README.md`](docs/README.md).

### Design decisions

See [`docs/decisions/`](docs/decisions/) for detailed design decisions. Critical design boundaries are consolidated in [`docs/decisions/critical-constraints.md`](docs/decisions/critical-constraints.md).

### Doc sync rules (on code changes)

| Code change | Update target | Skippable? |
|---|---|---|
| New directory under `src/<top-level>/` | Cluster README + `docs/README.md` architecture map | No |
| New module under `src-tauri/src/` | `src-tauri/README.md` + `docs/README.md` | No |
| New design decision finalized / existing decision revised | `docs/decisions/<topic>.md` — create new or append revision history | No |
| Pack type / registry semantic changes | `bundled-packs/README.md` + `src/runtime/README.md` | No |
| Individual file API / docstring changes | Not needed (`npm run doc` generates fresh output) | Yes |
| Bug fix / internal implementation changes | Not needed (commit message is source of truth) | Yes |

## Release

GitHub Actions builds signed `.dmg` files for macOS.

### Triggers

- `git tag v0.3.0 && git push origin v0.3.0` — runs automatically on tag push
- **Run workflow** button on the GitHub Actions page for manual execution

### Build targets

| arch | runner |
|---|---|
| aarch64 (Apple Silicon) | `macos-latest` |
| x86_64 (Intel) | `macos-13` |

### Private assets

Assets that cannot be redistributed (motion data, 3D models) are stored in Cloudflare R2 as `assets.zip` and downloaded via S3-compatible API during the build.

Zip contents:
```
assets.zip
├── animations/*.vrma
└── models/*.vrm
```

To update assets, zip the `animations/` and `models/` directories from `public/` and re-upload to the R2 bucket:
```bash
cd public
zip -r ../assets.zip animations/ models/
# Upload assets.zip to R2
```

### GitHub Secrets

| Secret | Purpose |
|---|---|
| `R2_ACCESS_KEY_ID` | Cloudflare R2 access key ID |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret access key |
| `R2_ENDPOINT` | R2 S3-compatible endpoint (`https://<account-id>.r2.cloudflarestorage.com`) |
| `R2_BUCKET` | R2 bucket name |
| `APPLE_CERTIFICATE` | Developer ID Application certificate (.p12), base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID email address |
| `APPLE_PASSWORD` | Apple ID app-specific password |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

### Artifacts

- On tag push: `.dmg` files are attached to a GitHub Release (draft)
- On manual run: `.dmg` files are uploaded as Actions Artifacts

## Pack Development

See [`src/sdk/README.md`](src/sdk/README.md) for how to write packs. Bundled packs ([`bundled-packs/`](bundled-packs/)) serve as reference implementations.

User-created packs are treated as local trusted code. No public registry, in-app community install, or `/charm:prepare-publish` is provided, so do not describe `/charm:create` output as sandboxed, reviewed, or publicly distributable artifacts.

To inspect user packs from a source checkout:

```bash
npm run check:pack -- ~/.charminal/packs/<pack-id>
npm run check:pack -- --mode publish-candidate ~/.charminal/packs/<pack-id>
```

`local-authoring` mode is for `/charm:create` output. `publish-candidate` mode is a preview of future pre-registry-review checks and is not an official publication gate at this time. No public submission feature exists yet, and JS/TS scanning relies on heuristics pending AST implementation.
