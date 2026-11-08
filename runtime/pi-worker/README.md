# Pi worker for the native continuity host

This private package implements the production entry and JSONL runtime for the native Pi adapter. It uses pinned `@earendil-works/pi-durable`, `pi-ai`, Chord and schema libraries at **1.5.0**. It does not launch Codex CLI or Claude Code, copy their credentials, or provide a production fake-model fallback. The running Yorishiro app is not switched by adding these files.

## Installation and first use

Released macOS apps contain a pinned Node **22.23.4** sidecar and this package's production dependencies. Users do not install Node, npm, a source checkout, Codex CLI, or Claude Code for the Pi execution route. The application resolves the sidecar and worker from its own signed bundle and checks the runtime manifest before use.

Open Pi setup from the autonomous execution view, choose the account/model and workspace permissions, and complete the browser login yourself. The application opens the official OpenAI authorization page and records only login state in the UI; tokens stay in the user's private data directory. Authentication does not silently switch to API-key billing.

The managed preference file is path-free:

```json
{
  "version": 2,
  "enabled": true,
  "provider": "openai",
  "model": "gpt-6.1-sol",
  "authMode": "oauth",
  "permissions": {
    "read": true,
    "write": false,
    "commands": ["workspace-info", "validate-json"]
  }
}
```

The current workspace comes from the app's selected folder. The OS user-data location determines authentication and private session storage. Runtime executables, worker entries and command arguments are resolved internally; they are not user-entered paths. Managed command presets are implemented by the bundled runtime. Permission controls remain an application boundary, not an OS sandbox.

Old absolute-path configurations and targets are supported only for recovery/migration compatibility. Previously accepted requests keep their original backend and immutable admission evidence. Updating configuration does not authorize resending them under another account, workspace or request ID. New managed targets persist portable runtime/workspace identities rather than executable or authentication paths.

## Development and packaging

From a source checkout, run `npm ci` and `npm run prepare:pi-runtime`. Tauri's development and build hooks run this preparation automatically. It downloads a pinned official Node archive, verifies its committed SHA-256, and stages the production-only worker with lockfile-based dependencies. A complete verified stage is reusable offline. Generated binaries and dependencies are ignored by Git.

Cross-builds use `npm run prepare:pi-runtime -- --target <Rust-target>`; Tauri also supplies the target to the build hook. The release workflow prepares Apple Silicon and Intel independently. See [runtime distribution](../../docs/pi-runtime-distribution.md) for manifest, licensing, signing and verification details.

The production entry still accepts explicit internally resolved arguments for process ownership and protocol tests. Unsupported provider/model/authentication, malformed permissions and missing runtime resources fail explicitly. Production never imports a fake provider. The login entry lives in this package and does not depend on the isolated experiments.

## Execution and evidence

The worker implements protocol v2: `ready`, correlated command `response`, and asynchronous `settled` records. Commands are `submit`, `status`, `resume` and `shutdown`. A command `id` correlates transport, while `requestId` identifies a durable submission across restarts. Acceptance is not completion. `status` looks up a request through a read-only transaction and never starts model work. Unknown or inconsistent request/submission ID pairs do not resume another task.

Final reports are parsed only from the selected input's authoritative answer. Tool evidence is read from that input's entry-to-answer bounds, following all pages. Active/failed inputs without authoritative terminal bounds return `toolEvidenceComplete: false`; an empty list then does not prove no tool ran. A `done` submission can still have interrupted/error tool results and must not be presented as successful execution.

Storage ownership uses a separate SQLite `BEGIN EXCLUSIVE` transaction, held until the harness closes. It is a cooperative single-writer protocol, not an OS sandbox. Process death releases that lock; recovery still needs the original session and durable request ID. Model retries are bounded at two, task restart limits remain bounded, tools execute sequentially, and a run has a 32-turn limit. `afterFailedRun: "continue"` lets already-queued independent inputs proceed after a failed run. This does not invent new work or make a failed input successful; the native owner still chooses useful work and handles failures.

stdin/stdout use LF-delimited UTF-8 JSON, with 1 MiB record limits. Both stdout and stderr must be continuously drained. The worker honors stdout backpressure. Closing stdin, SIGTERM or SIGHUP requests harness shutdown; an abruptly killed process leaves durable recovery to the next owner. SQLite's default persistence mode is not a power-loss guarantee.

## Recovery across a missing admission acknowledgement

New workers advertise an admission contract containing a protocol version, root conversation ID and random database epoch. The epoch is committed in a dedicated table inside the same `session.sqlite`, under the existing exclusive worker owner. It survives process restarts; a newly created or replaced database gets another epoch.

Before marking the first dispatch, the native host atomically commits the request's exact message, output schema, target and admission identity to a private `native-outbox` entry under that worker's session directory. It never replaces an existing entry with a regenerated prompt or schema. If recovery finds no receipt, it may submit that original payload only when all saved identities still match and the worker advertises the admission contract. The worker verifies the supplied admission identity before calling Pi's idempotent `root.submit`.

A durable receipt takes precedence: accepted or completed requests recover the original submission rather than creating a new one. Missing or malformed outbox evidence, a changed database epoch/root/runtime/policy, and older workers without the contract do not authorize automatic resubmission. Previously dispatched Codex requests keep their original backend. This covers the process-crash gap between the native dispatch record and durable worker admission; database snapshot rollback, power loss and arbitrary external exactly-once effects remain separate concerns.

## Tool permissions

### Bounded context, compaction and handoff

New native Pi requests use a reversible projection: at most 96 KiB of UTF-8 prompt and 256 KiB of conservatively encoded submit data, including escaping the persisted JSON envelope again. The 1 MiB protocol limit is unchanged. All explicit user messages, required correction sources and the current next step remain intact. Other evidence is selected as whole records; only three bounded recent receipt summaries are sent. If essential context alone cannot fit, execution fails explicitly rather than silently truncating authority.

The full native history is retained. A private `native-context/current.json` contains the original snapshot and receipts for the current request. The internal `read_continuity_context` tool reads exact JSON records in bounded Unicode pages; it accepts a request ID and collection/index, not a file path. It rejects stale IDs, public files and symlink aliases. The archive is replaced atomically only for a new request after prior work has settled. This keeps one current archive per generation rather than copying a growing history for every periodic check. Archives have a 16 MiB limit; the canonical native state is never truncated.

Pi 1.5's built-in model compaction remains enabled with its pinned defaults. Separately, the native host hands new work to a fresh numbered Pi storage generation after every 16 distinct settled requests. This handoff carries native user evidence and scope without requiring another model-generated summary. Accepted or uncertain requests always retain their original request ID, payload, generation and admission epoch. Only known-settled, unleased workers in the same family close gracefully; timeouts retain ownership. Previous databases and outboxes remain available for audit and recovery.

A legacy oversized request may be replaced only while its native dispatch flag is false. Its exact original record is archived immutably as `unsent-<requestId>.json`, then a new request ID receives bounded context. Correction targets and foreground intent survive context changes. A failed replacement restores the original saved request; an accepted request cannot enter this path.

Automatic Pi failures wait 5, 10, 20 and at most 30 minutes between subsequent attempts, with the deadline persisted across restarts. Failed requests no longer immediately create another request. Explicit user input or retry can proceed; valid completion resets the backoff. This handles repeated connection or compaction failures without treating unavailable service as successful work. These bounds and fixture tests do not prove long-duration usefulness, network availability or semantic quality.

All three policy keys are required: `{read, write, commands}`. Model tools are `read_file`, `write_file`, `edit_file` and `run_command`, exposed according to the policy. File operations are confined to the canonical workspace and exclude the worker's state; writes also exclude Git metadata. Existing files require matching expected content, and edits require a unique exact match. Files and command output have bounds. The filesystem/command implementation is in `workspace-tools.mjs`.

Commands choose only a configured `commandId`; the model supplies no shell text, executable, arguments or environment. Executables and argv are fixed by the host's policy, and command children receive a minimal environment without inherited provider credentials. Cancellation and deadlines terminate only the command's owned process/group.

Managed commands are individually opt-in. Existing settings gain no new commands automatically. All use bundled Node and a fixed helper/action argv; the model supplies only the granted command ID:

| ID | Fixed behavior |
| --- | --- |
| `workspace-info` | Bounded folder listing, canonical selected cwd, repository root/kind/branch, filesystem-verified linked registration, detected project commands and actual granted command IDs. |
| `validate-json` | Bounded JSON syntax validation; no project code executes. |
| `git-status` | `git --no-pager --no-optional-locks` status with short/branch output, normal untracked files, ignored submodules and `-- .` scope. |
| `git-diff` | Both unstaged and staged diffs with `--no-ext-diff --no-textconv --ignore-submodules=all -- .`; no commit, push or staging. |
| `project-check` | Own `package.json`: first declared `check`, `typecheck`, then `lint` script via `npm run`; otherwise own `Cargo.toml`: `cargo check`. |
| `project-test` | Own `package.json`: first declared `test:run`, `test:ci`, then `test` via `npm run`. A fallback Vitest `test` receives fixed `--run`; otherwise own `Cargo.toml`: `cargo test`. |
| `project-build` | Own `package.json`: `npm run build`; otherwise own `Cargo.toml`: `cargo build`. |

Git queries disable fsmonitor, hooks, optional locks, external diff and textconv. Repository observation reads bounded regular metadata files without evaluating Git configuration; a linked checkout is verified only when its canonical `commondir`, `worktrees` registration and `gitdir` backpointer agree with the current `.git` file. Worktrees are optional unless requested by the user or remembered project instructions. A supported/detected command is distinct from a permission grant.

Project presets execute trusted project code and may write build artifacts, lockfiles or other files. Selecting a command is a separate grant from file-tool read/write. `package.json` takes priority over Cargo when both exist; no parent folder is searched. npm uses the bundled Node executable, an ephemeral Node PATH alias and `CI=true`; provider environment credentials are not inherited. Git, npm and Cargo must be installed on the application PATH where required; missing tools/scripts produce actionable failures. Project presets have a 300-second deadline; existing inspection defaults stay 30 seconds. Output stays capped at 64 KiB and cancellation terminates the owned process group, including descendants. Legacy accepted requests retain their original command policy for recovery; the model cannot expand it.

Fixed project presets set `CARGO_INCREMENTAL=0` to limit additional incremental caches. An explicitly configured host `CARGO_TARGET_DIR` is preserved only for verified project grants; no shared cache location is discovered or invented. Without that variable, the project's normal Cargo target location applies.

Read-only Git presets first query only conversion-filter configuration names, with a 5-second/64-KiB limit and at most 128 validated driver names. They override every discovered driver's clean/process commands to empty and `required=false`; malformed names, query failures or limit violations block inspection. When filters are disabled, stdout explicitly warns that this is a raw comparison: filtered/LFS files may appear changed and must not be treated as edits. No conversion filter is executed to normalize these files.

These controls are an application tool boundary, **not OS isolation**. A permitted command can perform whatever its executable and project code do with the OS user's privileges. In particular, allowing model writes to project code and then running that mutable code is not equivalent to sandboxing it. Production deployment still needs the host's chosen trust/isolation policy, process supervision and signed runtime packaging.

## Verification

From this directory:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
```

Tests make **no real provider calls**. Configuration tests validate pinned static catalogs and spawn unconfigured production children with an empty environment. Protocol tests inject the upstream deterministic faux provider through a separate test-only entry, which always declares `fixture: true`; production entry does not import that provider. The package's `files` whitelist excludes tests and the fixture entry.

Actual Pi, SQLite, filesystem operations and subprocesses are used to check passive recovery, duplicate admission, stored identity mismatch, and a read operation. Another actual Harness test creates an artifact, edits it, executes a fixed verification command and returns its report, then reopens the same request with zero new model calls and one command effect. Workspace tests exercise escapes, symlinks, denied operations, stale content, command argv, size/deadline/cancellation limits and owned descendant cleanup. Test artifacts are retained in temporary directories with diagnostics pointing to their evidence.

These tests do not establish real-model reasoning quality, provider authentication success, arbitrary external exactly-once effects, 12-hour/24-cycle operation, or a user's 95-point quality evaluation. The application provides account, model and permission setup; packaged-app login and live acceptance remain separate checks.
