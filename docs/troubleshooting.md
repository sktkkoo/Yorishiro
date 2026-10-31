# Troubleshooting

Yorishiro alpha builds are local-first. Most recovery information lives in
`~/.yorishiro/` and can be checked without network access.

## First-run and health checks

On first launch, Yorishiro checks the selected terminal agent, user data path,
safe mode state, packs, and startup report. A healthy report stays out of the
way; issues that need attention are still shown. The full report is available
later from the Status section in Settings.

Agent setup is part of this initial health check, before an agent starts:

- An available preferred agent starts automatically, even when both Claude Code and Codex are installed. If it is missing, Yorishiro selects an installed Codex or the first other available agent and saves the choice. Setup appears only when no usable agent is detected.
- In **Agent installation**, **Install official CLI** downloads and runs the official installer. Codex and Claude Code have independent buttons, so you can install both. Installation starts only when you press the corresponding button.
- Keep Yorishiro open until installation finishes, then choose **Use Codex** or **Use Claude Code**. Sign in through the agent’s official login flow with your own account when prompted. “Installed” does not mean “signed in”; provider terms and any account or usage charges apply.
- The shared account and pricing note appears above the agents. Expand **Details** for provider terms, **Official setup**, and **Install command**. Use **Copy** to the right of the command to run it yourself. After an external installation, return to the Yorishiro window; it checks availability automatically when active again. If installation fails, expand **Installation details**, retry, or follow the official instructions.
- **Set up later** continues in a shell without starting an agent. You can configure the Agent setting and restart when ready. Existing shell or custom-command profiles keep their own startup behavior.

Built-in installer controls are available on macOS/Linux environments; other
environments show official setup links. This does not expand Yorishiro’s current
macOS-only product support. Installation requires internet access. Official guides:
[Codex](https://developers.openai.com/codex/cli) and
[Claude Code](https://code.claude.com/docs/en/setup).

## Important paths

| Path | Purpose |
|---|---|
| `~/.yorishiro/config.json` | User settings, including selected persona, scene, terminal agent, and disabled packs |
| `~/.yorishiro/cohabitation.json` | Runtime cohabitation-hours state. Not a user setting and not included in rollback snapshots |
| `~/.yorishiro/init.js` | User startup script. Skipped in safe mode |
| `~/.yorishiro/packs/` | User-created packs |
| `~/.yorishiro/.yorishiro-snapshots/` | Internal rollback snapshot store. Do not edit manually |
| `~/.yorishiro/last-startup.json` | Latest user pack load report |
| `~/.yorishiro/journal/` | Journal and memory files |
| `~/.yorishiro/shell/` | Generated shell integration files |
| `~/.yorishiro/runtime-plugin/` | Generated Yorishiro command plugin used by Claude Code and OpenCode launches |
| `~/.agents/skills/yori*/` | Yorishiro-managed `$yori-*` user skills discovered directly by Codex |

## Broken user pack

If a pack fails but Yorishiro still opens:

1. Open Settings.
2. Check Health for failed pack count.
3. Open Packs.
4. Select the failed pack and review the diagnosis.
5. Click the repair button to insert an agent-appropriate repair prompt into the terminal, then press Enter to let the AI fix it.
6. To fix manually instead, edit the file under `~/.yorishiro/packs/` and reload with `Cmd+R` / `Ctrl+R`.

If a pack prevents Yorishiro from opening, use safe mode.

## Safe mode

Safe mode skips user packs and `init.js`. It does not delete user data.

macOS:

```bash
YORISHIRO_SAFE_MODE=1 open /Applications/Yorishiro.app
```

From source:

```bash
YORISHIRO_SAFE_MODE=1 npm run tauri dev
```

After disabling or fixing the broken pack, launch again without
`YORISHIRO_SAFE_MODE`.

## Clean uninstall

Removing the Yorishiro app does not automatically delete user data or generated
agent integration cache. This matches the common desktop-app pattern where a
normal uninstall preserves settings and extensions for reinstall.

Claude/OpenCode commands are injected only when Yorishiro launches those
agents. Codex `$yori-*` skills are generated in Codex's standard user skill
discovery location, so they remain visible to Codex after Yorishiro has created
them.

To remove generated command integration cache without deleting packs, run:

```bash
rm -rf ~/.yorishiro/runtime-plugin
rm -rf ~/.agents/skills/yori{,-create,-update,-help,-shortcut,-tutorial}
```

To remove all Yorishiro user data, including packs, config, cohabitation state,
journal, memory, rollback snapshots, and generated files, remove `~/.yorishiro`. This is destructive and should be
treated separately from uninstalling the app binary.

## Crash recovery screen

If the React runtime crashes, Yorishiro shows a recovery screen with:

- safe mode command
- user pack directory
- startup report path
- error details
- Reload button

When reporting the crash, include the error details shown there and the contents
of `~/.yorishiro/last-startup.json` when relevant.

## Issue report checklist

User pack issues are outside the scope of Yorishiro issues. If a user pack is
causing the problem, try the repair button or Yorishiro update command first. File an
issue only if the problem persists with all user packs disabled (safe mode).

Include:

- Yorishiro version or commit
- operating system and CPU architecture
- install method: `.dmg`, source checkout, or other
- selected terminal agent: Claude Code, Codex, or OpenCode
- whether safe mode changes the behavior
- relevant user pack id, if any
- `~/.yorishiro/last-startup.json`, if it exists
- crash recovery error details, if shown
