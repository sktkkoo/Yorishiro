---
description: Charminal command reference, pack types, and MCP tools
argument-hint: "[topic]"
---

$ARGUMENTS

---

You are explaining Charminal's `/charm:*` commands. If `$ARGUMENTS` asks about a specific topic, focus there. Otherwise give a concise overview.

## First-time setup

To let the agent write packs without repeated permission prompts, add these entries to `~/.claude/settings.json` under `permissions.allow`:

```json
{
  "permissions": {
    "allow": [
      "Write(~/.charminal/packs/**)",
      "Read(~/.charminal/packs/**)",
      "Write(~/.charminal/init.js)",
      "Read(~/.charminal/init.js)"
    ]
  }
}
```

This is optional. Without it, Claude Code will ask for permission each time.

## Commands

| Command | Purpose |
|---|---|
| `/charm:create` | Create a new pack through conversation |
| `/charm:update` | Edit or tune an existing pack |
| `/charm:help` | Show this reference |
| `/charm:shortcut` | Add or edit keyboard shortcuts in `init.js` |
| `/charm:tutorial` | Start the first-run Charminal tutorial |

Command ids stay in English. Answer in the user's language when they clearly use one.

## Pack types

| Type | What it defines | Active count | Config key |
|---|---|---|---|
| `persona` | Character personality, reactions, body, voice | single | `primaryPersona` |
| `effect` | Visual effects such as particles, shake, fireworks | multi | - |
| `scene` | Background / foreground layer stack or R3F scene | single | `activeScene` |
| `ui` | Primary sidebar UI panels | single | `activeUi` |
| `ambient-ui` | Always-on overlays | multi | `activeAmbientUi` |

Packs live in `~/.charminal/packs/<id>/`. A pack normally has `manifest.json` and an entry file such as `persona.js`, `scene.js`, `effect.js`, `ui.js`, or `ambient-ui.js`. Persona packs can also use `persona.md` as the canonical prompt source.

## Runtime checks

When Charminal is running, MCP tools can inspect and repair packs:

- `list_packs()` — loaded / disabled / failed pack list
- `list_load_errors()` — details from the latest load failure
- `disable_pack({ id })` — disable a broken pack and persist it in config
- `enable_pack({ id })` — re-enable a disabled pack

If Charminal cannot start because of user packs, launch safe mode:

```bash
CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app
```

Safe mode skips user packs and adds `(Safe Mode)` to the window title.
