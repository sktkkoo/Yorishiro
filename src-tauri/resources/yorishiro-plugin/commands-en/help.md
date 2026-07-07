---
description: Yorishiro command reference, pack types, and MCP tools
argument-hint: "[topic]"
---

$ARGUMENTS

---

Yorishiro `/yori:*` command reference. If the user asks about a specific topic (`$ARGUMENTS`), focus on that section. Otherwise give a concise overview.

---

## First-time setup

When using Claude Code, you can reduce repeated permission prompts for `/yori:create` and `/yori:update` by adding these entries to `~/.claude/settings.json` under `permissions.allow`:

```json
{
  "permissions": {
    "allow": [
      "Write(~/.yorishiro/packs/**)",
      "Read(~/.yorishiro/packs/**)",
      "Write(~/.yorishiro/init.js)",
      "Read(~/.yorishiro/init.js)"
    ]
  }
}
```

Only add the four lines to the existing `allow` array. Do not change unrelated settings. `init.js` is the startup script used for keyboard shortcuts and similar hooks; see `/yori:shortcut`.

This setup is optional and Claude Code-specific. Codex uses its own approval policy and does not read `~/.claude/settings.json`.

---

## Commands

| Command | Purpose |
|---|---|
| `/yori:create` | Create a new pack through conversation |
| `/yori:update` | Edit or tune an existing pack |
| `/yori:help` | Show this reference |
| `/yori:shortcut` | Add or edit keyboard shortcuts in `init.js` |
| `/yori:tutorial` | Start the first-run Yorishiro tutorial |

Commands can take arguments. Examples: `/yori:create a cat-ear persona`, `/yori:update make my-scene darker`.

---

## Pack Types

| Type | What it defines | Active count | Config key |
|---|---|---|---|
| **persona** | Character personality, reactions, body, voice | single | `primaryPersona` |
| **effect** | Visual effects such as particles, shake, fireworks | multi, event-driven | - |
| **scene** | Background / foreground layer stack or R3F scene | single | `sceneByProject` -> `activeScene` |
| **ui** | Primary sidebar UI panels | single | `activeUi` |
| **ambient-ui** | Always-on overlay UI | multi | `activeAmbientUi` |

- `persona`, `scene`, and `ui` are **single-active**. The user picks scenes with `scene_activate`, which persists `sceneByProject` for the current project when possible and falls back to global `activeScene`; persona and UI picks live in `~/.yorishiro/config.json`.
- `effect` and `ambient-ui` are **multi-active**. Effects are invoked from persona handlers; ambient UI stays mounted while enabled.

---

## Pack Files

User packs live in `~/.yorishiro/packs/<id>/`.

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
  "yorishiroVersion": "^0.1.0",
  "entry": "<kind>.js"
}
```

- User packs use `.js` entry files.
- Bundled packs and user packs have different layouts. Bundled packs live under `bundled-packs/<kind_plural>/<id>/`; user packs are flat directories under `~/.yorishiro/packs/<id>/`.

---

## MCP Tools

When Yorishiro is running, these MCP tools are available.

### Pack Management

| Tool | Arguments | Purpose |
|---|---|---|
| `list_packs()` | - | List loaded / disabled / failed packs |
| `pack_diagnose({ id })` | pack id | Inspect one pack's status, manifest, load error, and repair hints |
| `list_load_errors()` | - | Show details from the latest pack load failure |
| `enable_pack({ id })` | pack id | Re-enable a disabled pack |
| `disable_pack({ id })` | pack id | Disable a broken pack immediately |
| `persona_goodbye_switch({ id })` | persona pack id | After creating a persona, say goodbye, switch, and reload |

### UI State / Parameter Tuning

| Tool | Arguments | Purpose |
|---|---|---|
| `controls_get({ scope, path? })` | scope (`scene` / `common`), optional path | Read parameters exposed in the F2 panels |
| `controls_set({ scope, path, value })` | scope, path, value | Write one F2 panel parameter; applies immediately |
| `controls_set_many({ scope, values })` | scope, values | Write multiple F2 panel parameters |
| `controls_transition({ scope, values, durationMs })` | scope, values, durationMs | Smoothly interpolate numeric parameters |

The F2 debug UI has two panels: **Common** for runtime-wide controls such as the base camera, and **Scene** for the active scene pack's lighting, post effects, layer opacity / blur, and camera modulation.

Scene packs expose tunable values through SDK controls (`useYorishiroControls` + `useControlsBridge`). Use `controls_get({ scope: "scene" })` to inspect paths, then use `controls_set` or `controls_transition` while tuning with the user. When the user asks to bake the result in, write the current values back to the source defaults so they persist on the next launch.

Writing common camera values such as `camera.x`, `camera.y`, `camera.z`, `camera.rotationX`, and `camera.rotationY` turns tracking off automatically and applies to the real camera. Use `controls_transition({ scope: "common", ... })` for smooth camera demos.

UI packs can keep their own key-value state through `ctx.state`; that state is accessible through `get_ui_state` / `set_ui_state`, but it does not appear in the Scene panel. The Scene panel is only for scene pack `ControlStore` values.

### Character Control

| Tool | Arguments | Purpose |
|---|---|---|
| `body_expression_set(...)` | preset, intensity?, durationMs?, hold? | Set a facial expression. Omit durationMs for a short transient expression; use durationMs: 0 or hold: true to keep it |
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

All SDK types are bundled into `~/.yorishiro/sdk.d.ts` (Yorishiro rewrites it on every startup, so it is always available — including in packaged builds). What you'll find there:

| Types | Group |
|---|---|
| `PersonaContext` / `EffectContext` / `UiContext` / `AmbientUiContext` | contexts |
| `DispatchEvent` / `TriggerMatch` / `ReactionType` | reactions |
| `PersonaDefinition` / `EffectDefinition` / `ScenePackDefinition` / `UiPackDefinition` / `AmbientUiPackDefinition` | pack definitions |

The standard hook / DispatchEvent catalog lives at `docs/catalogs/standard-hooks.md` (available when cwd is the Yorishiro repo). Generate the full API docs with `npm run doc`.

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

Custom shortcuts can be added through `init.js` (see `/yori:shortcut`).

---

## FAQ Routing

| Goal | Send the user to |
|---|---|
| Create a new pack | `/yori:create` |
| Edit an existing pack | `/yori:update` |
| Add a keyboard shortcut | `/yori:shortcut` |
| Recover from a broken pack | safe mode: `YORISHIRO_SAFE_MODE=1 open /Applications/Yorishiro.app` |

Safe mode skips all user packs and lets the user inspect / disable the failing pack through MCP tools (`list_load_errors()` / `disable_pack()`). Remove the environment variable and restart to return to normal mode; disabled packs remain disabled until re-enabled.

---

## Reference Files

| File | Contents |
|---|---|
| `~/.yorishiro/sdk-guide.md` | SDK documentation, including the twin-trigger co-emission idiom (Yorishiro writes this on every startup) |
| `bundled_example_read` (MCP tool) | Bundled pack source as a reference — pass a pack id from `list_packs`. Works in packaged builds where the source tree isn't on disk. |
| `bundled-packs/`, `docs/catalogs/standard-hooks.md`, `docs/philosophy/PHILOSOPHY.md` | Same material as files — available when cwd is the Yorishiro repo |
