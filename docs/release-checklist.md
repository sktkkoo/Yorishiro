# Release checklist

This checklist is the pre-release smoke test for Yorishiro release builds. Run
it from a fresh user profile when possible, or move the existing `~/.yorishiro/`
aside before testing.

## 0. Publish procedure

The mechanical steps for cutting a release. Everything after the tag push is
automated; the only required manual actions are the version bump, the tag, and
publishing the draft release.

1. **Bump the version** in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`, then run `npm install` and `cargo build` (updates
   `package-lock.json` / `Cargo.lock`). Update README status/badges if needed.
   Commit as `Release vX.Y.Z`.
2. **Tag and push**: `git tag vX.Y.Z && git push origin main vX.Y.Z`. The tag
   push triggers `.github/workflows/release.yml`, which builds both macOS
   architectures and creates a **draft** GitHub Release with:
   - versioned and stable-named `.dmg` files
   - in-app updater artifacts (`yorishiro_<arch>.app.tar.gz` + signatures)
   - `latest.json` (the update manifest the in-app updater polls)
3. **Publish the draft release.** This is the switch that delivers the update:
   the moment the release is published, `releases/latest/download/latest.json`
   resolves and existing installs (v0.5.3+) will offer the update in Settings.
4. **Homebrew: no action required.** The
   [homebrew-yorishiro](https://github.com/sktkkoo/homebrew-yorishiro) tap
   checks for new releases every 6 hours and updates the cask automatically.
   To sync it immediately:

   ```bash
   gh workflow run bump-yorishiro.yml -R sktkkoo/homebrew-yorishiro
   ```

Notes:

- The updater signing key lives in the `TAURI_SIGNING_PRIVATE_KEY` repo secret
  (empty passphrase; CI sets `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""`
  explicitly). Losing the private key means existing installs can never
  receive updates again — keep the original backed up.
- Releases before v0.5.3 do not contain the in-app updater, so those installs
  only update via Homebrew (`brew upgrade`) or manual download.
- The tap needs no per-release work. It only needs manual edits if the `.dmg`
  naming scheme or the `yorishiro.app` bundle name changes. Also note GitHub
  disables cron workflows in repos with no activity for 60 days; if releases
  pause that long, re-enable the tap's bump workflow with
  `gh workflow enable bump-yorishiro.yml -R sktkkoo/homebrew-yorishiro`.

## 1. Build artifacts

- Run `npm run build`.
- Run `npm run test:run`.
- Run `npm run test:rust`.
- Build the desktop bundle for the target platform.
- Confirm bundled assets are fetched without missing VRM, animation, or voice
  errors.

## 2. Fresh macOS install

- Install the `.dmg` build into `/Applications`.
- Release builds are signed and notarized and need no extra steps. For locally
  built unsigned bundles only, run:

```bash
xattr -cr /Applications/yorishiro.app
```

- Launch Yorishiro from Finder.
- Confirm the first-run health check appears once in the installed production
  build. Do not rely on the dev build's localStorage state for this check.
- Confirm the first-run check reports the selected terminal agent clearly.
- Dismiss the first-run check, quit, and relaunch. It should not reappear.

## 3. Agent startup

- Test with `terminalAgent: "claude"`.
- Test with `terminalAgent: "codex"`.
- Confirm the selected agent session starts exactly once.
- Confirm `/yori:help` works.
- Confirm `/yori:tutorial` can be prefilled on a fresh profile.
- Confirm switching the Agent setting says it applies on next launch.

## 4. Settings and diagnostics

- Open Settings with the sidebar button.
- Confirm Health shows:
  - Yorishiro home path
  - selected terminal agent status
  - safe mode state
  - pack status summary
  - startup report path
- Confirm Packs lists bundled packs and user packs.
- Select a bundled pack and confirm diagnosis is healthy.

## 5. User pack recovery

- Create or copy a test user pack under `~/.yorishiro/packs/`.
- Confirm hot reload loads the pack.
- Break the pack entry file intentionally.
- Confirm Settings > Health and Packs show a failed pack.
- Confirm the pack can be disabled from Settings.
- Relaunch normally and confirm disabled packs stay skipped.

## 6. Safe mode

- Launch with:

```bash
YORISHIRO_SAFE_MODE=1 open /Applications/yorishiro.app
```

- Confirm the window title includes `(Safe Mode)`.
- Confirm user packs and `init.js` are skipped.
- Confirm Settings > Health reports safe mode.
- Confirm the Packs section can still diagnose and disable user packs.
- Relaunch without `YORISHIRO_SAFE_MODE` and confirm normal mode returns.

## 7. Core interaction smoke test

- Confirm Yori loads and idles.
- Confirm the selected scene renders.
- Confirm `Cmd+T` opens a shell tab.
- Confirm `Ctrl+Tab` / `Ctrl+Shift+Tab` switches tabs.
- Confirm `Cmd+W` closes a shell tab but not the main agent tab.
- Confirm Terminal Reference Marker inserts a fixed marker by user gesture.
- Confirm Voice Summary can be toggled off and on.
- Confirm Attention Aura can be toggled.

## 8. Crash recovery

- Temporarily introduce a local rendering error in a development build.
- Confirm the crash recovery screen appears.
- Confirm it shows:
  - safe mode command
  - user pack directory
  - startup report path
  - error details
- Confirm Reload attempts a normal reload.

## 9. Release notes

- Confirm README Status matches the artifact being published.
- Confirm macOS is described as the primary supported platform.
- Confirm Windows remains marked experimental unless manually verified.
- Confirm unreleased pack registry / community install / publish flow features
  are not described as available.
- Confirm asset credits and missing asset behavior are documented.
