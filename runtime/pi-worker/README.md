# Pi worker for the native continuity host

This private package implements the production entry and JSONL runtime for the native Pi adapter. It uses pinned `@earendil-works/pi-durable`, `pi-ai`, Chord and schema libraries at **1.5.0**. It does not launch Codex CLI or Claude Code, copy their credentials, or provide a production fake-model fallback. The running Yorishiro app is not switched by adding these files.

## Configuration

Node **22.19.0 or newer** is required. The native host passes every option explicitly:

```sh
node /absolute/pi-worker/main.mjs \
  --session-dir /absolute/private-state \
  --cwd /absolute/workspace \
  --provider openai \
  --model '<explicit model from the pinned catalog>' \
  --permissions-json '{"read":true,"write":false,"commands":[]}'
```

The entry supports `openai` and `anthropic`. Authentication is explicit: `--auth-mode apiKey` (also the default for older callers) requires the selected provider's `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. `--auth-mode oauth --auth-path /absolute/private/auth.json` accepts only `openai` and requires a Pi-owned OAuth credential. OAuth mode disables environment API-key resolution entirely; a missing OAuth credential never switches to API billing. There is no CLI-session or fake-model fallback. Catalog validation is local and makes no model/network request. Unknown models are rejected instead of substituted. An actual model call starts only after an authorized `submit` or `resume` command.

Missing/invalid configuration, missing authentication, unsupported providers, and unavailable catalog models emit a fixed `startup_error` code and exit before opening session storage. Production `main.mjs` rejects `--fixture`. Exception messages and credential values are not emitted in protocol diagnostics.

The native configuration contains `nodePath`, `workerEntry`, `provider`, `model`, `authMode`, `authPath` and explicit `permissions`. These identities and capabilities can be persisted; credentials must not be placed in command arguments or that metadata. Provider/model/auth-mode/auth-path/policy/workspace identity is stored before model work and returned in `ready`. Missing authentication metadata in a legacy identity means `apiKey` with a null path only; it never adopts OAuth implicitly. Reopening with another identity is rejected; an existing Pi database without that identity is not silently adopted. The host must retain a pending request's original target while recovering it.

OAuth example (requires a previously authorized Pi-owned login; this worker never starts login):

```sh
node runtime/pi-worker/main.mjs \
  --session-dir /absolute/session --cwd /absolute/workspace \
  --provider openai --model gpt-6.1-sol \
  --auth-mode oauth --auth-path /absolute/private/pi/auth.json \
  --permissions-json '{"read":true,"write":false,"commands":[]}'
```

`credential-store.mjs` implements Pi's public CredentialStore JSON schema, compatible with `experiments/pi-provider`'s `auth.json` and `installation.json`. It neither imports experiment code nor reads CLI credential locations. Login uses a stable installation UUID and `agentName:Yorishiro`; those are Pi OAuth registration arguments, not ordinary model-request fields. The store's `deviceId()` is async; a login caller preloads it before supplying Pi's synchronous `getDeviceId` callback. No tokens need to be copied to use the same store after review.

The private directory and final files are checked against symlinks and group/other access. Atomic replacement uses 0600 same-directory temporary files, file fsync, rename and directory fsync. A separate `provider-owner.sqlite` transaction serializes each read/list/modify/delete across cooperating processes, and process-local queues serialize all stores for the same canonical directory. Unlike a lifetime account lock, idle workers for different workspaces can share the account. Acquisition retries asynchronously with cancellation and a 10-second contention limit; a `modify` lock covers the entire async refresh callback and atomic replacement. A cooperating callback must honor its cancellation signal: the store never releases a lock while that callback may still mutate credentials. If a callback returns a rotated credential as cancellation races completion, the result is persisted to avoid losing the valid token. Failed callbacks release the lock without replacing it; process death releases the SQLite lock. An existing development login driver using the older lifetime lock blocks store operations until that driver exits; it should later adopt this shared module.

The worker closes the credential store only after the harness has confirmed closure. If harness closure fails, its owner lease and model resources remain retained while the process lives. Read/list do not log credentials; protocol failures report fixed categories. Static readiness does not prove token validity, user entitlement, or provider availability, and no login/token refresh/model request was made by the offline tests.

The auth directory is excluded from read/write tools even when the workspace contains it, including canonical symlink aliases. Fixed commands still run with the OS user's privileges; this file-tool exclusion is not an OS sandbox or a guarantee against arbitrary other programs bypassing the cooperative ownership protocol.

`diagnose.mjs` understands both explicit auth modes. OAuth readiness reads only a private file's provider/type metadata through `credentialMetadata`, never creates auth directories or lock databases, never refreshes tokens, and never uses an inherited API key as a fallback. Atomic replacement makes this a read-only snapshot; it can become stale immediately. An expired OAuth credential still counts as present. Wrong credential type or malformed/private-file failures produce a fixed `authentication_invalid` category with no credential body in diagnostics.

## Native host selection

After building a native host with the Pi routing command, the presence of `~/.yorishiro/continuity/pi-worker.json` selects the dedicated worker independently of the terminal tab. The frontend reads that preference on startup and window focus. It waits for the host response before selecting a new route. Malformed or inaccessible Pi configuration remains an explicit error instead of selecting another CLI. An older running host without the routing command keeps its existing route until a compatible native build is running.

The file must contain explicit absolute paths and a model from the pinned provider catalog, for example:

```json
{
  "nodePath": "/absolute/path/to/node",
  "workerEntry": "/absolute/path/to/Yorishiro/runtime/pi-worker/main.mjs",
  "provider": "openai",
  "model": "<explicit model from the pinned catalog>",
  "authMode": "apiKey",
  "permissions": {
    "read": true,
    "write": false,
    "commands": []
  }
}
```

This is a template, not an installed configuration. Creating the file selects Pi for future work; do so only when the intended model, credentials, workspace and permissions have been chosen. For API-key mode, the selected key must be available in the native app process environment. For OAuth, explicitly set `authMode` to `oauth` and `authPath` to the absolute path of the private Pi-owned credential file; only the `openai` provider accepts this mode. Neither a key nor a token belongs in the native configuration file. This source package does not install a Node runtime or dependencies into a released app; install its pinned dependencies before using an absolute source entry.

Native execution and offline diagnosis use the same strict authentication metadata parser and pass the selected mode and path to their respective entries. A worker must echo the same mode/path in `ready`; a mismatch cannot silently select another authentication mechanism. Old saved targets without authentication metadata retain API-key mode and no path. Only the mode and reference are persisted in native targets and outbox evidence; credential contents are not copied.

An already-dispatched request keeps its stored backend and target even after the configuration or terminal selection changes. Removing Pi configuration changes future route selection, not the identity of pending work or its recovery target. A stored Pi target without explicit permissions remains readable but cannot start a production worker.

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

All three policy keys are required: `{read, write, commands}`. Model tools are `read_file`, `write_file`, `edit_file` and `run_command`, exposed according to the policy. File operations are confined to the canonical workspace and exclude the worker's state; writes also exclude Git metadata. Existing files require matching expected content, and edits require a unique exact match. Files and command output have bounds. The filesystem/command implementation is in `workspace-tools.mjs`.

Commands choose only a configured `commandId`; the model supplies no shell text, executable, arguments or environment. Executables and argv are fixed by the host's policy, and command children receive a minimal environment without inherited provider credentials. Cancellation and deadlines terminate only the command's owned process/group.

A host command may set `timeoutMs` to an integer from 1 to 300000. Omitting it keeps the 30000 ms default and the existing permission identity. The model cannot override this value. For a fixed Rust verification command, the host can use 120000 ms and invoke Cargo with `CARGO_INCREMENTAL=0`; other commands keep their existing deadline. Cancellation and output limits still apply.

These controls are an application tool boundary, **not OS isolation**. A permitted command can perform whatever its executable and project code do with the OS user's privileges. In particular, allowing model writes to project code and then running that mutable code is not equivalent to sandboxing it. Production deployment still needs the host's chosen trust/isolation policy, process supervision and signed runtime packaging.

## Verification

From this directory:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
```

Tests make **no real provider calls**. Configuration tests validate pinned static catalogs and spawn unconfigured production children with an empty environment. Protocol tests inject the upstream deterministic faux provider through a separate test-only entry, which always declares `fixture: true`; production entry does not import that provider. The package's `files` whitelist excludes tests and the fixture entry.

Actual Pi, SQLite, filesystem operations and subprocesses are used to check passive recovery, duplicate admission, stored identity mismatch, and a read operation. Another actual Harness test creates an artifact, edits it, executes a fixed verification command and returns its report, then reopens the same request with zero new model calls and one command effect. Workspace tests exercise escapes, symlinks, denied operations, stale content, command argv, size/deadline/cancellation limits and owned descendant cleanup. Test artifacts are retained in temporary directories with diagnostics pointing to their evidence.

These tests do not establish real-model reasoning quality, provider authentication success, arbitrary external exactly-once effects, native distribution, 12-hour/24-cycle operation, or a user's 95-point quality evaluation. The application must still provide its backend/model/policy selection and perform that live acceptance run.
