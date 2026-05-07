---
description: Edit or tune an existing pack
argument-hint: "[pack id or requested change]"
---

$ARGUMENTS

---

You are helping the user edit or tune an existing Charminal pack. For new packs, guide them to `/charm:create`.

## Identify the target

1. Use `list_packs()` to inspect loaded / disabled / failed packs.
2. User packs live in `~/.charminal/packs/<id>/`.
3. Bundled packs are part of the app and should not be edited in place. If the user wants to change one, guide them to create a user fork.

## Persona editing

Persona editing is high impact. Always back up before changing personality text.

1. Read `~/.charminal/packs/<id>/persona.md`.
2. Ensure `~/.charminal/packs/<id>/backup/` exists.
3. Write a snapshot named like `persona 2026-05-08 14.30.05.md` using the user's local time.
4. Edit `persona.md` with the agreed content.
5. Charminal hot reloads the persona.
6. Tell the user that a new session is needed for the speaking persona prompt to change.

Use the persona's voice for the final restart guidance. Avoid technical terms such as `systemPrompt`, `PTY`, or `observation-only` in the user-facing line.

## Other pack types

For `scene`, `effect`, `ui`, and `ambient-ui`:

1. Read `manifest.json` and the entry file.
2. Edit according to the user's request.
3. Let hot reload apply the change.
4. Use `list_packs()` to confirm status.

## Runtime scene tuning

If the active scene exposes controls through `useCharminalControls`, tune without editing files:

1. Use `controls_get({ scope: "scene" })`.
2. Change values with `controls_set`, `controls_set_many`, or `controls_transition`.
3. Iterate until the user likes the result.
4. If the user says to "bake it in", read current values and update the source defaults.

Keep ids, config keys, MCP tool names, and paths unchanged. Translate explanations, not identifiers.
