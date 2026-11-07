# Pi provider readiness and explicit login driver

This isolated experiment prepares **Pi-owned OpenAI ChatGPT subscription authentication** for a future Yorishiro worker. It targets provider `openai`, model `gpt-6.1-sol`, using Pi's modern `openai-responses` integration. It does not use Codex CLI, copy Codex credentials, switch billing to an API key, or run a model prompt.

No new dependencies are installed. `pi.mjs` uses `createRequire` to locate the sibling `pi-harness` installation, validates `pi-ai@1.5.0`, and loads its documented ESM import exports (Pi's package has no CommonJS root export). Bootstrap that sibling's existing lockfile if necessary; this experiment does not install globally.

## Offline verification

```sh
cd experiments/pi-provider
npm test
```

Tests use private custom fixture directories below ignored `artifacts/`; all credentials in those tests are fake. Actual Pi static catalog APIs verify the provider/model mapping without invoking a provider, logging in, refreshing tokens, or making network calls. Other tests exercise mocked login interaction, serialized credential updates, atomic 0600 persistence, stable installation UUID, redacted malformed/storage failures, symlink rejection, and a real competing-process/SIGKILL lock-release scenario.

## Readiness command

```sh
node experiments/pi-provider/driver.mjs --check
```

The default Pi-owned credential path is `~/.yorishiro/continuity/pi/auth.json`. Use `--auth-path <path>` for a separate private directory. `--check` emits one metadata-only JSON record: provider/model, static-catalog presence, supported authentication methods, credential presence and type, and `networkVerified:false`. It does not expose tokens, API keys, environment values or credential bodies. An expired saved OAuth credential still reports present; this is not an account entitlement, token-validity or model-access check.

Checking initializes the private directory and separate owner-lock database if absent. It does not create the credential file or installation UUID. Ambient environment auth is intentionally disabled, so inherited API keys cannot silently change the chosen connection. `authMethods` lists Pi's capabilities, not a request to select API billing.

## Explicit browser login

```sh
node experiments/pi-provider/driver.mjs --login --timeout-seconds 300
```

This command explicitly invokes `models.login("openai", "oauth", interaction, {getDeviceId, agentName:"Yorishiro"})`. It emits a private `auth_url` record and waits for the user to visit that URL and complete sign-in/consent. The script does not open a browser. Pi listens on `127.0.0.1:1455/auth/callback`; if the browser callback does not finish, the user can paste the full callback URL followed by LF on stdin. Treat that input and the authorization URL as transient login material; do not copy them into general logs. Pi validates state and exchanges the code; the driver does not implement its own OAuth protocol.

The default timeout is 300 seconds, with a maximum of 600. stdin EOF cancels login. Manual input is bounded at 64 KiB; Pi's per-prompt abort signal cancels the unused input prompt if the callback wins. Timeout/cancellation and provider/storage errors emit generic redacted failure categories. No raw OAuth error body or returned credential is logged. A successful login stores the Pi-owned credential and emits only connection metadata. It still does not call a model or verify access by spending tokens.

## Credential and ownership behavior

`PiCredentialStore` implements Pi's public `CredentialStore` contract. It serializes all reads and read-modify-write operations in one process, and keeps a separate SQLite `BEGIN EXCLUSIVE` owner lock for the full driver lifetime. A second cooperating driver for the same directory fails before reading credentials. Closing or killing the owner releases that SQLite lock; no PID-file deletion is used. The same owner protocol must be used by any future sidecar reading this store; this is not general cross-process file locking against arbitrary writers.

The directory must be private (no group/other permissions), and final credential, UUID and lock paths must be regular private files, never symlinks. Credentials and the stable installation UUID are written to new 0600 temporary files in the same directory, fsynced, renamed atomically, and followed by directory fsync. Existing CLI credential locations named `.codex` or `.claude` are rejected, including paths resolved through directory aliases. This is a local cooperative-owner design; it does not defend against malicious same-user processes changing paths, arbitrary direct writers, broken network-filesystem locking, or device/host failure. OS keychain integration and production packaging remain future work.

Offline tests use fixture paths and fake credentials. A real login requires the explicit command above and the user's browser sign-in and consent. A timed-out attempt does not establish a connection; start a fresh flow when the user is ready. Never copy credentials from an existing CLI account. The offline tests do not prove real OAuth success, user model access, paid model quality, or twelve-hour autonomous operation.

Primary pinned references: [OpenAI provider](https://github.com/earendil-works/pi/blob/9e870f6f002ca6c21ce010fdb99122afe3738b28/packages/ai/src/providers/openai.ts), [Pi OAuth implementation](https://github.com/earendil-works/pi/blob/9e870f6f002ca6c21ce010fdb99122afe3738b28/packages/ai/src/auth/oauth/openai-chatgpt.ts), [credential-store contract](https://github.com/earendil-works/pi/blob/9e870f6f002ca6c21ce010fdb99122afe3738b28/packages/ai/src/auth/types.ts), [Models API](https://github.com/earendil-works/pi/blob/9e870f6f002ca6c21ce010fdb99122afe3738b28/packages/ai/src/models.ts).
