# Release checklist

This checklist is the pre-release smoke test for Charminal alpha builds. Run it
from a fresh user profile when possible, or move the existing `~/.charminal/`
aside before testing.

## 1. Build artifacts

- Run `npm run build`.
- Run `npm run test:run`.
- Run `npm run test:rust`.
- Build the desktop bundle for the target platform.
- Confirm bundled assets are fetched without missing VRM, animation, or voice
  errors.

## 2. Fresh macOS install

- Install the `.dmg` build into `/Applications`.
- For unsigned alpha builds, run:

```bash
xattr -cr /Applications/charminal.app
```

- Launch Charminal from Finder.
- Confirm the first-run health check appears once.
- Confirm the first-run check reports the selected terminal agent clearly.
- Dismiss the first-run check, quit, and relaunch. It should not reappear.

## 3. Agent startup

- Test with `terminalAgent: "claude"`.
- Test with `terminalAgent: "codex"`.
- Confirm the selected agent session starts exactly once.
- Confirm `/charm:help` works.
- Confirm `/charm:tutorial` can be prefilled on a fresh profile.
- Confirm switching the Agent setting says it applies on next launch.

## 4. Settings and diagnostics

- Open Settings with the sidebar button.
- Confirm Health shows:
  - Charminal home path
  - selected terminal agent status
  - safe mode state
  - pack status summary
  - startup report path
- Confirm Packs lists bundled packs and user packs.
- Select a bundled pack and confirm diagnosis is healthy.

## 5. User pack recovery

- Create or copy a test user pack under `~/.charminal/packs/`.
- Confirm hot reload loads the pack.
- Break the pack entry file intentionally.
- Confirm Settings > Health and Packs show a failed pack.
- Confirm the pack can be disabled from Settings.
- Relaunch normally and confirm disabled packs stay skipped.

## 6. Safe mode

- Launch with:

```bash
CHARMINAL_SAFE_MODE=1 open /Applications/charminal.app
```

- Confirm the window title includes `(Safe Mode)`.
- Confirm user packs and `init.js` are skipped.
- Confirm Settings > Health reports safe mode.
- Confirm the Packs section can still diagnose and disable user packs.
- Relaunch without `CHARMINAL_SAFE_MODE` and confirm normal mode returns.

## 7. Core interaction smoke test

- Confirm CLAI loads and idles.
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
- Confirm macOS is described as the primary alpha target.
- Confirm Windows remains marked experimental unless manually verified.
- Confirm unreleased pack registry / community install / publish flow features
  are not described as available.
- Confirm asset credits and missing asset behavior are documented.
