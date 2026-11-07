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
