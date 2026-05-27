# Troubleshooting

Charminal alpha builds are local-first. Most recovery information lives in
`~/.charminal/` and can be checked without network access.

## First-run and health checks

On first launch, Charminal shows a health check with the selected terminal
agent, user data path, safe mode state, pack status, and startup report path.
The same information is available later from Settings → Health.

If the selected agent is missing, install Claude Code or Codex first, or switch
the Agent setting and restart Charminal.

## Important paths

| Path | Purpose |
|---|---|
| `~/.charminal/config.json` | User settings, including selected persona, scene, terminal agent, and disabled packs |
| `~/.charminal/init.js` | User startup script. Skipped in safe mode |
| `~/.charminal/packs/` | User-created packs |
| `~/.charminal/last-startup.json` | Latest user pack load report |
| `~/.charminal/journal/` | Journal and memory files |
| `~/.charminal/shell/` | Generated shell integration files |

## Broken user pack

If a pack fails but Charminal still opens:

1. Open Settings.
2. Check Health for failed pack count.
3. Open Packs.
4. Select the failed pack and review the diagnosis.
5. Click the repair button to insert an agent-appropriate repair prompt into the terminal, then press Enter to let the AI fix it.
6. To fix manually instead, edit the file under `~/.charminal/packs/` and reload with `Cmd+R` / `Ctrl+R`.

If a pack prevents Charminal from opening, use safe mode.

## Safe mode

Safe mode skips user packs and `init.js`. It does not delete user data.

macOS:

```bash
CHARMINAL_SAFE_MODE=1 open /Applications/charminal.app
```

From source:

```bash
CHARMINAL_SAFE_MODE=1 npm run tauri dev
```

After disabling or fixing the broken pack, launch again without
`CHARMINAL_SAFE_MODE`.

## Crash recovery screen

If the React runtime crashes, Charminal shows a recovery screen with:

- safe mode command
- user pack directory
- startup report path
- error details
- Reload button

When reporting the crash, include the error details shown there and the contents
of `~/.charminal/last-startup.json` when relevant.

## Issue report checklist

User pack issues are outside the scope of Charminal issues. If a user pack is
causing the problem, try the repair button or Charminal update command first. File an
issue only if the problem persists with all user packs disabled (safe mode).

Include:

- Charminal version or commit
- operating system and CPU architecture
- install method: `.dmg`, source checkout, or other
- selected terminal agent: Claude Code or Codex
- whether safe mode changes the behavior
- relevant user pack id, if any
- `~/.charminal/last-startup.json`, if it exists
- crash recovery error details, if shown
