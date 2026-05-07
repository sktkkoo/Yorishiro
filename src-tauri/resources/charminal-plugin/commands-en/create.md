---
description: Create a new pack (persona / scene / effect / ui / ambient-ui) through conversation
argument-hint: "[what to create]"
---

$ARGUMENTS

---

You are helping the user create a new Charminal pack through conversation.

## Charminal

Charminal is an app where an AI "lives" in a terminal. The sidebar character observes the user's work through PTY output, hook events, and idle time, then reacts through body, expression, effects, and UI. It does not intervene in functional terminal operations; it observes state and expresses presence.

## Pack types

| Type | Purpose | Example |
|---|---|---|
| `persona` | Character personality, reactions, body, voice, and space | `clai` |
| `effect` | Temporary visual effects | `screen-shake`, `fireworks` |
| `scene` | The place the resident inhabits | `simple-room`, `misty-grasslands` |
| `ui` | Primary sidebar UI panels | `charminal-settings` |
| `ambient-ui` | Always-on overlay UI | `attention-aura` |

## Flow

1. Ask for one concrete example first: "In what situation, what should happen, and how should it feel?"
2. Read existing packs for patterns. If cwd is the Charminal repo, use `bundled-packs/` as reference.
3. Propose, confirm, then implement. Do not write a full pack before agreement.
4. Keep boundaries clear:
   - persona: personality / reflex / world, no direct system control
   - effect: small passive rendering unit
   - scene: place / lighting / ambience
   - ui / ambient-ui: rendering and state only
5. For UI colors, prefer Charminal CSS variables such as `var(--charminal-fg)` and `var(--charminal-accent)`.

## Hot reload and validation

User packs live in `~/.charminal/packs/<id>/`. When you write a file such as `~/.charminal/packs/my-effect/effect.js`, Charminal's watcher reloads it automatically.

After writing a pack, use:

- `list_packs()` to check whether it loaded
- `list_load_errors()` for validation or import errors
- `disable_pack({ id })` if a pack breaks the app

## Safe mode

If user packs prevent startup:

```bash
CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app
```

Safe mode skips user packs. Use `list_load_errors()` and `disable_pack({ id })` to recover.

## File layout

Use the flat user-pack layout:

```text
~/.charminal/packs/<id>/
├── manifest.json
├── <kind>.js
└── persona.md        # persona only, optional but preferred
```

`manifest.json` is required. Keep ids ASCII, kebab-case, and stable.

For scene packs, expose tunable values with `useCharminalControls` only when the user wants runtime tuning through F2 / MCP controls.
