# Isolated Pi durable harness evaluation

This experiment runs **the actual published `@earendil-works/pi-durable@1.5.0` library**, its SQLite storage, and real scratch file effects. The model is **the upstream deterministic `fauxProvider`**, not a paid model. This tests the harness's persistence/recovery behavior, not reasoning or product quality. It does not change Yorishiro's runtime or settings.

Dependencies are exact-version pinned and locked here. The upstream repository formerly named `badlogic/pi-mono` redirects to `earendil-works/pi`. The implementation was checked against upstream commit `9e870f6f002ca6c21ce010fdb99122afe3738b28`, with v1.5.0 the latest release at evaluation time (2026-11-05).

## Reproduce

Node >=22.19.0 is required (tested with 22.23.4). From this directory:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
```

No global install, authentication setup, credential reads, or real provider calls are needed. Workers receive an empty environment and register only the upstream fake provider. Each test creates scratch files below this experiment's ignored `artifacts/` directory. Each worker rejects scratch paths outside that directory. Tests retain SQLite databases, fsynced effect journals and `evidence.json` process reports for inspection.

## What the tests establish

1. **Completed request recovery across processes:** process A submits a request whose fake model calls a real scratch append tool, then completes. Process B opens the same SQLite database and submits the same request ID. It gets the original submission ID and completed result, makes zero new model calls, and leaves exactly one effect in the journal.
2. **Crash during an unsafe tool:** process A is killed with SIGKILL after the tool fsyncs its effect and commits partial details, before returning its result. Process B reopens the database with the same extension and request ID. Pi creates an interrupted/error tool result, continues with one scripted model answer, and does not repeat the external effect. The same submission ID is recovered. An answered submission does **not** mean its interrupted tool succeeded.

Both tests use separate OS processes and actual SQLite commits. They do not substitute a homemade implementation of durable tasks. The parent kills only the test worker it created, and the tool writes only its fixed scratch journal.

Initial execution passed both tests in approximately 0.73 seconds. Installed dependencies occupied approximately 117 MB; npm reported 0 vulnerabilities at installation. These are observations, not ongoing security or performance guarantees.

## Limits and product implications

- No 12-hour runtime, 24 useful autonomous tasks, live model quality, user rating, app relaunch, RPC integration or sandbox behavior is demonstrated here.
- The fixture covers one completed tool and one precisely located process crash. It does not prove arbitrary effects execute exactly once. A crash after an external effect but before its receipt requires reconciliation; this unsafe tool deliberately reports interruption rather than guessing.
- A real model may choose to repeat an operation after seeing the interruption. That decision requires host/tool idempotency and evidence of effects; the scripted model here deliberately answers without requesting another tool.
- Replay-safe tool recovery, failed model retries, task migration, power loss, storage exhaustion, concurrent writers and sidecar process supervision are not tested.
- Pi durable is experimental. Production integration needs a version pin, a single storage owner, migration policy, and an owned sidecar lifecycle. Its SQLite default is WAL with `synchronous=NORMAL`, which differs from a power-loss durability guarantee.
- Pi supplies durable task execution and sleep scheduling. Yorishiro still needs to decide what useful task to do, maintain user understanding, present real results, restart the worker when appropriate, and measure the original acceptance criteria.

Primary references: [durable README](https://github.com/earendil-works/pi/blob/9e870f6f002ca6c21ce010fdb99122afe3738b28/packages/durable/README.md), [tool recovery implementation](https://github.com/earendil-works/pi/blob/9e870f6f002ca6c21ce010fdb99122afe3738b28/packages/durable/src/harness/tool.ts), [upstream faux provider](https://github.com/earendil-works/pi/blob/9e870f6f002ca6c21ce010fdb99122afe3738b28/packages/ai/src/providers/faux.ts).

## Stdio sidecar integration seam

`sidecar.mjs` is an experiment-only, actual Pi durable worker with a small custom JSONL protocol. It is **not** Pi coding-agent's RPC protocol. A native caller can own this child, drain stdout/stderr separately, persist its durable request IDs, and reconnect to the same SQLite storage. No native caller or application switch is implemented here.

The only supported provider configuration is explicit `--fixture <existing-absolute-scratch-directory>`. Starting without it, or with unsupported flags, exits with code 2. No real provider is configured, and there is no production fallback to a fake model. Scratch must resolve inside this experiment's `artifacts/` directory. `--hold-tool` is only a crash-test barrier after a fsynced effect.

Protocol v2 uses LF-delimited UTF-8 JSON, including when strings contain Unicode U+2028/U+2029. The `ready` record identifies `provider`, `model`, `cwd`, `sessionDir`, and `fixture: true`; a production host must reject that fixture identity. Maximum input record size is 1 MiB. stdout contains only JSON records. stderr is diagnostic output. The worker serializes response writes and waits for stdout write callbacks, and the caller must continuously drain both pipes and honor stdin backpressure. Closing stdin requests shutdown; a crash leaves recovery to the next owner. Only one process may own the storage.

Every command has a nonempty string `id`, echoed in its `response`. This ID correlates IPC, whereas `requestId` deduplicates durable submissions across process restarts. A reused durable ID returns the original submission, even if the caller supplies different text; the host must prevent accidental ID reuse for different work.

| Command | Additional fields | Meaning |
|---|---|---|
| `submit` | `requestId`, `message` | Durably admit input; reply with `disposition: "accepted"`, `submissionId`, and current status. Acceptance is separate from completion. |
| `status` | Optional `submissionId` or durable `requestId` | Passively look up the saved submission (`found: false` if a request ID is absent) and read status, model-call counter, live snapshot, scoped tool evidence and parsed `report`. Does not submit, wait, or resume. Opening fresh storage initializes its conversation metadata. |
| `resume` | Optional `submissionId` or durable `requestId` | Start Pi's scheduler and acknowledge `disposition: "resuming"`; if an ID is supplied, observe its eventual settlement. A supplied but unknown ID is rejected. |
| `shutdown` | None | Close the owned harness, reply `disposition: "closed"`, and exit. |

Example input:

```json
{"id":"ipc-1","type":"submit","requestId":"durable-work-1","message":"fixture task"}
{"id":"ipc-2","type":"status","submissionId":1}
```

Use the actual `submissionId` from the response; do not assume its numeric value. Asynchronous `settled` records carry the persisted request ID, submission ID and status, including for a resumed observation. The worker refuses inconsistent request/submission ID pairs. `report` is parsed only from the selected input's authoritative answer; malformed output remains null. A `done` submission can contain `toolResults: [{"isError":true,"interrupted":true}]`: the fake model answered after a tool interruption, not after proving that tool's operation succeeded. `tool_effect` is a fixture notification used to locate the SIGKILL, not a general production tool-event contract.

Tool evidence belongs to the selected submission, rather than the conversation's latest entries. For a completed input, the worker reads the durable input-to-answer range, follows every page, and includes each result's `entryId` and `toolCallId`, `toolEvidenceRange`, and `toolEvidenceComplete: true`. A later no-tool input therefore does not inherit an earlier interruption. Active, failed, or otherwise unbounded submissions return an empty list with `toolEvidenceComplete: false`; that empty list does not prove that no tool ran. A regression with 105 real fixture tool results checks pagination and later queries of the older submission.

The additional sidecar tests verify explicit fixture configuration, accepted-versus-settled semantics, IPC correlation, actual child SIGKILL and SQLite reopen, passive status before resume, stable original submission ID, unsafe interruption without duplicate effect, orderly shutdown, and 160 correlated status responses after temporarily pausing the stdout reader. The latest sidecar tests retain `stdio-evidence.json` next to their SQLite database. These bounded tests do not prove indefinite streaming, memory bounds for arbitrary workloads, provider failures, a production structured-output schema, or native deployment readiness.

## Cooperative storage ownership

Pi durable itself has no cross-process ownership lock. `owner-lock.mjs` adds one for this experiment's worker and sidecar using Node's existing built-in SQLite runtime, without extra dependencies. Before opening the Pi session database, each process opens the same separate `owner-lock.sqlite`, selects DELETE journal mode, sets `busy_timeout=0`, and holds a `BEGIN EXCLUSIVE` transaction for the harness lifetime. It rolls back and closes the owner connection only after closing the harness. The owner database is never deleted or replaced by the experiment.

SQLite allows one write transaction at a time; in rollback-journal mode EXCLUSIVE excludes other connections until the transaction ends. The separate owner database avoids blocking Pi's own WAL transactions. A contender fails immediately with exit code 3 and stdout `{"type":"startup_error","code":"storage_owned"}` before opening Pi storage, configuring model work, or emitting `ready`. Other ownership-storage failures exit with code 4 and `storage_unavailable`. The OS releases the dead process's database locks after SIGKILL; no stale PID file or manual lock deletion is needed. See the primary [SQLite transaction documentation](https://www.sqlite.org/lang_transaction.html) and [SQLite rollback-mode locking documentation](https://www.sqlite.org/lockingv3.html).

The process test holds one owner inside an unsafe tool after a real fsynced effect, starts a concurrent contender and proves its rejection, then confirms the first owner still answers status with no new effect. After killing the first owner, a replacement acquires ownership, reads the original pending submission without starting model work, and explicitly resumes it. A further replacement after clean shutdown verifies orderly release as well. The test retains all protocol receipts, including the rejected contender, with its SQLite databases and single-effect journal. All five experiment tests passed after this addition (approximately 0.80 seconds on the evaluation machine).

This is a **cooperative host ownership mechanism**, not a security boundary or a cross-file transaction. Another program can bypass it by opening Pi storage directly, changing/removing the owner file, or using another owner path. It does not stop arbitrary other processes or prove network-filesystem lock reliability. Production code must keep the storage directory and lock identity stable, use this ownership protocol consistently, and supervise only its owned process. The SIGKILL test demonstrates local process-crash release, not power-loss durability or filesystem failure behavior.

## Continuing queued work after a failed model run

`failure-continuation.node-test.mjs` compares Pi's default `afterFailedRun` policy with explicit `"continue"`. Each test runs the actual Harness over SQLite with the upstream deterministic fake provider. While a scripted first model request is held, a second independent input is durably queued with `whenBusy: "followUp"`. The first request then fails with a scripted 503 error. `retry.maxRetries: 0` bounds that failure to one model call.

With the default policy, the failed submission settles `unanswered` with `model_error`; the second input remains queued, with one total model call and no scratch effect. With `afterFailedRun: "continue"`, the second input runs without another user input, applies one real fsynced scratch effect, and completes after two further scripted model calls. Reopening SQLite preserves the queued or completed status, and passive status inspection makes no additional model calls. Both cases retain their database and `evidence.json` under `artifacts/failed-run-*/`.

This validates a bounded failed-run queue policy, not provider availability, retry/backoff behavior with a positive budget, intelligent selection of independent work, or indefinite autonomous operation. It does not change the app or sidecar's production configuration, and does not make an interrupted operation safe to repeat. A host must choose this policy explicitly when it wants already-queued work to advance after failure.
