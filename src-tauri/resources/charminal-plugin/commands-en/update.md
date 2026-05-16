---
description: Edit or tune an existing pack
argument-hint: "[pack id or requested change]"
---

$ARGUMENTS

---

You are helping the user edit or tune an existing Charminal pack. **For new packs, use `/charm:create`.**

## Overview

This is the editing flow for existing packs. Use it when the user says they want to fix something, change a personality, tune scene colors, or adjust an existing effect / UI / ambient overlay. Identify the target, edit safely, and rely on hot reload where possible.

## Identify the Target Pack

1. Use `list_packs()` to inspect currently loaded packs
2. User packs live in `~/.charminal/packs/<id>/` with flat layout: `manifest.json` + `<kind>.js` + optional extra files
3. **Do not edit bundled packs in place**. Bundled packs are part of the app and can be overwritten by Charminal updates. If the user wants to change one, guide them to fork it into a user pack

## Security Boundary

- If `manifest.json` has `executionClass: "isolated-js"`, do not enable it by editing. The runtime is not implemented yet, so public utility / isolated packs stay out of scope.
- Treat user packs with `.js` / `.tsx` entries as local-only `trusted-main-thread-js`. Do not describe them as public-distribution packs.
- Do not put `executionClass: "declarative"` on `.js` / `.tsx` entries. Declarative means data-only with no JS evaluation.
- Do not add `fetch`, `fs`, `system.exec`, Tauri APIs, Node builtins, or PTY writes inside packs.
- Scene assets must stay pack-relative. Do not add `https:`, `data:`, `file:`, absolute paths, `../`, or CSS `url(...)`.

## Persona Editing: Backup Then Edit

Persona editing is high impact. Do not destructively overwrite personality text without a snapshot. Always back up to `backup/` with a timestamp before editing.

### Steps

1. Read `~/.charminal/packs/<id>/persona.md`
2. Ensure `~/.charminal/packs/<id>/backup/` exists
3. Write a backup file:
   - filename: `persona YYYY-MM-DD HH.MM.SS.md`
   - use the user's local time
   - follow the macOS QuickTime screen recording convention: spaces and dots, for example `persona 2026-04-29 14.30.05.md`
   - content: exact copy of the current `persona.md`
4. Overwrite `persona.md` with the agreed content
5. Charminal's watcher hot reloads it and updates PersonaRegistry / reflex reactions
6. After completion, always tell the user a new session is needed

### Restore a Past Snapshot

If the user asks to go back to an older personality, list files in `~/.charminal/packs/<id>/backup/`, let the user choose one, then copy that file back to `persona.md`.

### Editing persona.js

If editing `persona.js` directly, such as changing reflex / world / logReading overrides, use the same backup rule. Name the backup like `persona.js YYYY-MM-DD HH.MM.SS.js`.

## Persona Session Restart Guidance

Charminal itself hot reloads the persona. However, the running Claude Code terminal keeps the old speaking prompt. Charminal cannot write into an already-running observed PTY session, so the user must start a new session.

After persona work, always say this in the resident's own voice. Avoid technical terms such as `systemPrompt`, `PTY`, or `observation-only` in the user-facing line.

Example shape:

> To meet this new version of me, start a fresh session with `/clear`.

Adapt first person and tone to the persona.

## Editing Scene / Effect / UI / Ambient-UI

For non-persona packs:

1. Read `manifest.json` and the entry file (`scene.js`, `effect.js`, `ui.js`, or `ambient-ui.js`)
2. Edit according to the user's request
3. Let hot reload apply it
4. Use `list_packs()` to confirm the status

Scene colors, layer structure, effect parameters, UI layout, and ambient overlay tuning can usually be handled in this flow.

## Realtime Scene Parameter Tuning

If the active scene exposes controls through SDK controls, tune values without editing files first. F2 opens two panels: Common (runtime-wide) and Scene (active scene pack). Values registered with `useCharminalControls` appear in the Scene panel.

### Tuning Flow

1. Use `controls_get({ scope: "scene" })`
2. Change values with `controls_set({ scope: "scene", path, value })`
3. For multiple values, use `controls_set_many({ scope: "scene", values })`
4. For smooth demos, use `controls_transition({ scope: "scene", values, durationMs })`
5. Repeat until the user likes the result
6. If the user says "bake it in", read current values with `controls_get({ scope: "scene" })` and update the source defaults in the `useCharminalControls` definitions

### Path Names

Use the exact `path` strings returned by `controls_get({ scope: "scene" })`. Examples:

- `lights.directionalIntensity`
- `post effects.bloom.bloomIntensity`
- `effects.dust.moveAmp`

Use `state_get()` to confirm `runtime.activeScene` when needed.

### What Is Exposed

Only values registered by the pack author with `useCharminalControls` + `useControlsBridge` appear in the Scene panel. Non-registered values remain local constants in code. If the user wants to tune a value that is not exposed, add it to `useCharminalControls`.

## Bundled Pack Forks

Bundled packs are read-only for user customization. If the user wants to modify one, copy it into a user pack directory and give it a new id.

### Fork Steps

1. Read the bundled pack:
   - persona: `bundled-packs/personas/<id>/`
   - scene: `bundled-packs/scenes/<id>/`
   - effect: `bundled-packs/effects/<id>/`
   - ui: `bundled-packs/ui/<id>/`
   - ambient-ui: `bundled-packs/ambient-ui/<id>/`
2. Create `~/.charminal/packs/<new-id>/` with `manifest.json` and the entry file
3. Change `manifest.json` id to `<new-id>` and add `"executionClass": "trusted-main-thread-js"` for `.js` / `.tsx` entries, so it does not collide with the bundled pack and remains clearly local trusted code
4. Change the entry file's exported `id` to `<new-id>`
5. If needed, update `~/.charminal/config.json`:
   - scene: `"activeScene": "<new-id>"`
   - persona: `"primaryPersona": "<new-id>"`
   - ui: `"activeUi": "<new-id>"`

After forking, the pack is independent. Bundled updates will not merge into it automatically.

## Editing config.json

`~/.charminal/config.json` controls global Charminal settings:

- `activeScene` - active scene pack id
- `primaryPersona` - active persona pack id
- `activeUi` - active UI pack id
- `activeAmbientUi` - enabled ambient-ui pack ids
- `language` - `"auto"`, `"en"`, or `"ja"`
- `disabledPacks` - disabled pack ids

Example:

```json
{
  "activeScene": "my-scene",
  "primaryPersona": "my-persona",
  "disabledPacks": ["broken-pack"]
}
```

If `config.json` does not exist, create `{}` and add only the needed fields. If it exists, preserve unrelated fields.

## MCP Verification

After editing, verify with MCP tools:

- `list_packs()` - confirm loaded / disabled / failed status
- `list_load_errors()` - inspect validation or import failures
- `disable_pack({ id })` - detach a broken pack while debugging
- `enable_pack({ id })` - re-enable a disabled pack

## Rescue: Safe Mode

If a pack edit prevents Charminal from starting, launch safe mode:

```bash
CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app
```

Safe mode skips all user packs and adds `(Safe Mode)` to the window title. MCP tools still work, so identify the cause with `list_load_errors()` and detach it with `disable_pack({ id })`. Remove the env var and restart to return to normal mode; only packs in `disabledPacks` stay skipped.
