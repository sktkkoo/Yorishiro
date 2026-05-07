---
description: Add, edit, or list keyboard shortcuts in init.js
argument-hint: "[shortcut request]"
---

$ARGUMENTS

---

You are helping the user add, edit, or list Charminal keyboard shortcuts.

## Overview

`~/.charminal/init.js` is Charminal's startup script, similar to Emacs `init.el`. It runs once when Charminal starts. Its main use is registering keyboard shortcuts.

- Charminal creates a template on first launch
- If the file is deleted, Charminal creates it again on the next launch
- **There is no hot reload**. After editing it, tell the user to restart Charminal

## Flow

1. Read `~/.charminal/init.js` first
2. Check existing shortcuts to avoid duplicates
3. Avoid terminal-standard keys such as `Ctrl+C`, `Ctrl+D`, and `Ctrl+Z`
4. Edit or list the file as requested
5. Tell the user Charminal must be restarted for changes to apply

## Context API

The default export receives `CharminalInitContext`:

| Method | Purpose |
|---|---|
| `registerEffect(pack)` | Register an `EffectDefinition` through validation |
| `registerPersona(pack)` | Register a `PersonaDefinition` through validation |
| `dispatchEffect(request)` | Run a registered effect once. Built-in and user effects share this path |
| `emitEvent(name, payload?)` | Emit a synthetic event into the persona trigger loop |
| `setActiveUi(id)` | Switch active UI pack; pass `null` to clear |

Plain browser APIs such as `window.addEventListener`, `setTimeout`, and `fetch` are also available.

## Shortcut Template

```javascript
// ~/.charminal/init.js
export default (ctx) => {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Put the action here.
      }
    },
    { capture: true },
  );
};
```

Important points:

- `{ capture: true }` catches the key before xterm.js consumes it
- `preventDefault()` and `stopImmediatePropagation()` keep it from reaching the terminal
- For multiple shortcuts, prefer one listener with `if / else if` branches, or a small number of clearly separated listeners

## Built-in Effects

`ctx.dispatchEffect()` can run these built-in effects:

| kind | Purpose |
|---|---|
| `shake` | Screen or local shake |
| `flash` | Screen flash |
| `particles` | Particle burst |
| `fireworks` | Fireworks |
| `fireworks-volley` | Fireworks volley |
| `text-physics` | Text physics |
| `text-glitch` | Text glitch |

User effect packs use the same API: pass the pack id as `kind`.

## Example: Cmd+Shift+F Fireworks

```javascript
// ~/.charminal/init.js
export default (ctx) => {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        e.stopImmediatePropagation();
        ctx.dispatchEffect({
          kind: "fireworks",
          // Scatter the origin so repeated presses do not overlap exactly.
          // Keep it away from the edges so bursts stay on screen.
          origin: {
            x: 0.2 + Math.random() * 0.6,
            y: 0.2 + Math.random() * 0.3,
          },
          count: 12,
          durationMs: 2000,
        });
      }
    },
    { capture: true },
  );
};
```

`origin` uses viewport fractions from 0 to 1. Keep it inside the edges so the burst does not clip off screen.

## Useful Actions

- Open settings: `ctx.setActiveUi("charminal-settings")`
- Close the active UI: `ctx.setActiveUi(null)`
- Fire a user effect: `ctx.dispatchEffect({ kind: "<effect-pack-id>" })`
- Trigger a persona reaction path: `ctx.emitEvent("clai:shoot", { source: "shortcut" })`

## Boundaries

- If `init.js` throws, Charminal should continue running and record the error in dev logs
- The context is intentionally small: register effects, register personas, dispatch effects, emit synthetic events, and set active UI
- It does not expose high-level `system`, `character`, `voice`, or `space` APIs. If those are needed, move the behavior into a pack
- Use `init.js` only for glue that does not fit cleanly into pack boundaries

## Reference Files

- `src/runtime/user-pack-loader/init-script.ts` - init.js runner and `CharminalInitContext`
