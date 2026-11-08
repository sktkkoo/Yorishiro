# Pi runtime distribution

The macOS application carries the Pi execution runtime. End users select a workspace and permissions and log in through the app; they do not install Node/npm or edit executable paths. The bundle requires macOS 11 or newer, matching the bundled Node executable's deployment target.

## Reproducible preparation

`npm run prepare:pi-runtime` stages two generated outputs:

- `src-tauri/binaries/yorishiro-pi-node-<target>`: Node 22.23.4 from the matching official archive.
- `src-tauri/resources/pi-worker`: explicit production worker files, lockfile-installed production dependencies, Node's license and an integrity manifest.

The target is Tauri's `TAURI_ENV_TARGET_TRIPLE`, an explicit `--target` argument, or the development host. Apple Silicon and Intel macOS archives are pinned independently. Linux targets support native CI/development; this does not claim a Linux or Windows application release.

The preparer checks the archive against SHA-256 values committed from [Node's official release checksums](https://nodejs.org/dist/v22.23.4/SHASUMS256.txt). It extracts only `bin/node` and `LICENSE` to stdout, validates target architecture, installs the exact Pi 1.5.0 dependency lock with lifecycle scripts disabled, and excludes tests, experiments, authentication and developer state. npm is required only on build machines. A valid existing stage is checked and reused without network access. A corrupt archive or staged file fails explicitly.

`manifest.json` records schema version, Node/Pi versions, target, official archive hash, pre-signing Node binary hash, worker lockfile hash and relative resource hashes. It contains no checkout, home, workspace or authentication path. The Node binary's pre-signing hash is build provenance: signing changes Mach-O bytes, so runtime/release verification checks executable architecture and signature rather than comparing that hash after signing.

## Bundle locations and identities

Tauri bundles the Node executable as an [external binary](https://v2.tauri.app/develop/sidecar/) named `yorishiro-pi-node` beside the native app executable. Worker resources are under the bundle resource directory's `resources/pi-worker`. The native app derives both locations from its running bundle. Source locations are a debug-build fallback, not a release dependency; there is no system-Node or PATH fallback.

The managed preference schema contains provider/model, enabled state, authentication mode and permission choices. Native targets use portable references. The chosen workspace and OS user-data directory resolve local paths only when execution starts. Old accepted requests retain their original recovery identities; onboarding or moving an app does not authorize a second submission.

Each worker dependency carries its original package license files; `licenses/Node-LICENSE.txt` carries Node and its bundled third-party notices. Generated resources and binaries remain outside Git.

## Optional development capabilities and stalled work

The `workspace-info` preset reports the canonical selected folder, repository kind,
linked-worktree registration, branch, granted commands and detected project actions.
An existing verified worktree satisfies a user request to use a worktree. Worktrees
remain optional and follow the user's instructions or applicable remembered preferences.

Git status/diff and project check/test/build are separate opt-in presets. Existing
settings gain no new permissions on upgrade. Git is required for Git commands;
project commands require the project's npm or Cargo toolchain on the application
PATH. These developer tools are not dependencies of ordinary Pi conversations.
Commands have fixed arguments and bounded runtime/output. Project scripts are
trusted local code and can generate files or perform other actions under the
user's account; the permission UI describes that scope explicitly.
The output bound limits the preview, not command execution. Large stdout/stderr
continues until the command exits, times out or is cancelled. Results retain the
actual exit code and a bounded prefix/tail; output truncation is not a failure.
Private session logs retain at most 16 MiB per command and 20 logs/64 MiB per
session. `read_command_output` reads a bounded page or tail by the returned log
ID, only for currently granted commands in that session. When a log exceeds its
cap, its omitted middle is explicit. Logging failure does not hide completion.
Git inspections discover and disable configured clean/process conversion filters
without evaluating their commands. Invalid or excessive filter metadata fails
closed. When filters are disabled, output explicitly notes that raw comparisons
can mark filtered/LFS files as changed even without a source edit.

Progress evidence distinguishes inspections from successful file edits and verified
project commands. A read, inventory or Git status check does not establish an
implementation change. The model also reports whether entrusted work remains and
the concrete obstacle when blocked. After three automatic attempts on pending work
without verified changes, project checks or substantive draft updates, the host
switches automatic execution off and reports the reason once. The counter and pause
survive restarts. New user input, a workspace change, explicit retry or turning
execution On resets the counter; an idle conversation with no pending work does
not trigger this pause. Accepted requests keep their existing recovery identity.

## Signing and release checks

The macOS build includes the sidecar in Tauri's signing/notarization pipeline. Release verification inspects the extracted updater app and the app mounted from the DMG. It requires:

- the app's Developer ID chain, hardened runtime, signed entitlements, secure timestamp, Gatekeeper assessment and stapled notarization;
- the sidecar's valid nested signature, Developer ID chain, hardened runtime, secure timestamp and JIT entitlement;
- matching sidecar architecture and complete worker manifest/resource hashes.

The container app owns the stapled ticket; a nested executable does not require a separate staple. A missing sidecar, incomplete dependency tree or altered worker prevents release verification from succeeding. Preparation and local unsigned/ad-hoc builds do not establish Developer ID/notarized release trust.

## Verification commands

```sh
npm run prepare:pi-runtime
npm run prepare:pi-runtime -- --check
npm run test:pi-package
npm run build:macos:app
npm run check:macos-signature
```

Tests cover an app copied into another home with spaces in its path after the original checkout is removed, corrupt archive/cache rejection, worker resource tampering, target architecture, offline reuse and signature policy. A real clean-user packaged-app login and model run remain an independent acceptance check; fixture success does not establish account entitlement or a quality score.
