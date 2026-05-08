---
description: Charminal command reference, pack types, and MCP tools
argument-hint: "[topic]"
---

$ARGUMENTS

---

Charminal `/charm:*` command reference. If the user asks about a specific topic (`$ARGUMENTS`), focus on that section. Otherwise give a concise overview.

---

## First-time setup

To let the agent write packs through `/charm:create` or `/charm:update` without repeated permission prompts, add these entries to `~/.claude/settings.json` under `permissions.allow`:

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

Only add the four lines to the existing `allow` array. Do not change unrelated settings. `init.js` is the startup script used for keyboard shortcuts and similar hooks; see `/charm:shortcut`.

This setup is optional. Without it, Claude Code will ask for permission each time.

---

## Commands

| Command | Purpose |
|---|---|
| `/charm:create` | Create a new pack through conversation |
| `/charm:update` | Edit or tune an existing pack |
| `/charm:help` | Show this reference |
| `/charm:shortcut` | Add or edit keyboard shortcuts in `init.js` |
| `/charm:tutorial` | Start the first-run Charminal tutorial |

Commands can take arguments. Examples: `/charm:create a cat-ear persona`, `/charm:update make my-scene darker`.

---

## Pack Types

| Type | What it defines | Active count | Config key |
|---|---|---|---|
| **persona** | Character personality, reactions, body, voice | single | `primaryPersona` |
| **effect** | Visual effects such as particles, shake, fireworks | multi, event-driven | - |
| **scene** | Background / foreground layer stack or R3F scene | single | `activeScene` |
| **ui** | Primary sidebar UI panels | single | `activeUi` |
| **ambient-ui** | Always-on overlay UI | multi | `activeAmbientUi` |

- `persona`, `scene`, and `ui` are **single-active**. The user picks them through `~/.charminal/config.json`.
- `effect` and `ambient-ui` are **multi-active**. Effects are invoked from persona handlers; ambient UI stays mounted while enabled.

---

## Pack Files

User packs live in `~/.charminal/packs/<id>/`.

Required files:

| File | Role |
|---|---|
| `manifest.json` | Shared declaration for id / type / version / entry |
| `<kind>.js` | Pack implementation: `persona.js`, `effect.js`, `scene.js`, `ui.js`, or `ambient-ui.js` |
| `persona.md` | Persona only. Canonical source for the character prompt |

Common `manifest.json` fields:

```json
{
  "id": "<pack-id>",
  "type": "<persona | effect | scene | ui | ambient-ui>",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "<kind>.js"
}
```

- User packs use `.js` entry files.
- Bundled packs and user packs have different layouts. Bundled packs live under `bundled-packs/<kind_plural>/<id>/`; user packs are flat directories under `~/.charminal/packs/<id>/`.

---

## MCP Tools

When Charminal is running, these MCP tools are available.

### Pack Management

| Tool | Arguments | Purpose |
|---|---|---|
| `list_packs()` | - | List loaded / disabled / failed packs |
| `list_load_errors()` | - | Show details from the latest pack load failure |
| `enable_pack({ id })` | pack id | Re-enable a disabled pack |
| `disable_pack({ id })` | pack id | Disable a broken pack immediately |

### UI State / Parameter Tuning

| Tool | Arguments | Purpose |
|---|---|---|
| `controls_get({ scope, path? })` | scope (`scene` / `common`), optional path | Read parameters exposed in the F2 panels |
| `controls_set({ scope, path, value })` | scope, path, value | Write one F2 panel parameter; applies immediately |
| `controls_set_many({ scope, values })` | scope, values | Write multiple F2 panel parameters |
| `controls_transition({ scope, values, durationMs })` | scope, values, durationMs | Smoothly interpolate numeric parameters |

The F2 debug UI has two panels: **Common** for runtime-wide controls such as the base camera, and **Scene** for the active scene pack's lighting, post effects, layer opacity / blur, and camera modulation.

Scene packs expose tunable values through SDK controls (`useCharminalControls` + `useControlsBridge`). Use `controls_get({ scope: "scene" })` to inspect paths, then use `controls_set` or `controls_transition` while tuning with the user. When the user asks to bake the result in, write the current values back to the source defaults so they persist on the next launch.

Writing common camera values such as `camera.x`, `camera.y`, `camera.z`, `camera.targetX`, `camera.targetY`, and `camera.targetZ` turns tracking off automatically and applies to the real camera. Use `controls_transition({ scope: "common", ... })` for smooth camera demos.

UI packs can keep their own key-value state through `ctx.state`; that state is accessible through `get_ui_state` / `set_ui_state`, but it does not appear in the Scene panel. The Scene panel is only for scene pack `ControlStore` values.

### Character Control

| Tool | Arguments | Purpose |
|---|---|---|
| `body_expression_set(...)` | expression params | Set the character expression |
| `body_animation_play(...)` | animation params | Play an animation |
| `body_motion_cancel()` | - | Cancel the current motion |

### Space Control

| Tool | Arguments | Purpose |
|---|---|---|
| `space_effect_play(...)` | effect params | Play a visual effect |
| `scene_screenshot(...)` | optional camera override | Capture the scene canvas |

Use `controls_transition({ scope: "common", values, durationMs })` for camera moves. For lighting, post effects, scene layer blur / opacity, and camera modulation, inspect paths with `controls_get({ scope: "scene" })`, then tune with `controls_set` / `controls_transition`.

### UI Control

| Tool | Arguments | Purpose |
|---|---|---|
| `ui_sidebar_set(...)` | width, optional durationMs | Set sidebar width in px, optionally animated |
| `ui_terminal_set(...)` | opacity, optional durationMs | Set terminal opacity, optionally animated |

### Runtime State

| Tool | Arguments | Purpose |
|---|---|---|
| `state_get()` | - | Read a runtime-wide state snapshot |

---

## SDK Type Overview

Useful type definition files for pack development:

| File | Contents |
|---|---|
| `src/sdk/context.d.ts` | `PersonaContext` / `EffectContext` / `UiContext` / `AmbientUiContext` |
| `src/sdk/reaction.d.ts` | `DispatchEvent` / `TriggerMatch` / `ReactionType` |
| `docs/catalogs/standard-hooks.md` | Standard hook / DispatchEvent classes and usage notes |
| `src/sdk/pack.d.ts` | `PersonaDefinition` / `EffectDefinition` / `ScenePackDefinition` / `UiPackDefinition` / `AmbientUiPackDefinition` |

Generate the full API docs with `npm run doc`.

---

## Boundary Rules

Pack boundaries are enforced at the type level.

| Pack type | Unavailable APIs | Reason |
|---|---|---|
| **persona** | `ctx.system.*` | Environment operations are a separate responsibility |
| **effect** | Almost everything except renderer, audio, and time | Effects are short-lived rendering units without persistent state |
| **scene** | Handlers | Scene packs are declarative data |
| **ui** | `ctx.system` / `ctx.character` / `ctx.voice` | UI packs handle rendering and state only |
| **ambient-ui** | persona / system APIs | Ambient UI receives renderer and attention information only |

If a handler needs to trigger another reaction, announce a **synthetic event** with `ctx.emitEvent()`, then match it from a persona trigger.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| **F1** or sidebar button | Toggle settings screen |
| **F2** | Toggle debug panels (Common / Scene) |
| **Cmd+T** | Open a new shell tab |
| **Cmd+W** | Close the active tab (main tab cannot be closed) |
| **Ctrl+Tab / Ctrl+Shift+Tab** | Switch to next / previous tab |
| **Cmd+1–9** | Jump to the Nth tab |

Custom shortcuts can be added through `init.js` (see `/charm:shortcut`).

---

## FAQ Routing

| Goal | Send the user to |
|---|---|
| Create a new pack | `/charm:create` |
| Edit an existing pack | `/charm:update` |
| Add a keyboard shortcut | `/charm:shortcut` |
| Recover from a broken pack | safe mode: `CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app` |

Safe mode skips all user packs and lets the user inspect / disable the failing pack through MCP tools (`list_load_errors()` / `disable_pack()`). Remove the environment variable and restart to return to normal mode; disabled packs remain disabled until re-enabled.

---

## Reference Files

| File | Contents |
|---|---|
| `src/sdk/README.md` | SDK documentation, including the twin-trigger co-emission idiom |
| `docs/catalogs/standard-hooks.md` | Standard hook / DispatchEvent catalog |
| `bundled-packs/` | Bundled pack examples and implementation patterns |
| `docs/philosophy/CHARMINAL.md` | Charminal's design background |
