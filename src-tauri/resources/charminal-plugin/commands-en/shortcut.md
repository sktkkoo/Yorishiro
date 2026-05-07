---
description: Add, edit, or list keyboard shortcuts in init.js
argument-hint: "[shortcut request]"
---

$ARGUMENTS

---

You are helping the user add, edit, or list Charminal keyboard shortcuts.

## Overview

`~/.charminal/init.js` is a startup script, similar to Emacs `init.el`. Charminal runs it once at startup. Its main use is registering keyboard shortcuts.

- Charminal creates a template on first launch
- If it is deleted, Charminal creates it again on the next launch
- It is not hot reloaded. After editing it, tell the user to restart Charminal

## Flow

1. Read `~/.charminal/init.js`.
2. Check existing shortcuts to avoid duplicates.
3. Avoid terminal-standard keys such as `Ctrl+C`, `Ctrl+D`, and `Ctrl+Z`.
4. Edit the file.
5. Tell the user Charminal must be restarted.

## Context API

The default export receives `ctx`:

| Method | Purpose |
|---|---|
| `registerEffect(pack)` | Register an inline `EffectDefinition` |
| `registerPersona(pack)` | Register an inline `PersonaDefinition` |
| `dispatchEffect(request)` | Run a built-in or user effect once |
| `emitEvent(name, payload?)` | Emit a synthetic event into the persona trigger loop |
| `setActiveUi(id)` | Switch active UI pack; pass `null` to clear |

Plain browser APIs such as `window.addEventListener`, `setTimeout`, and `fetch` are available.

## Template

```javascript
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
- `preventDefault()` and `stopImmediatePropagation()` keep it out of the terminal
- For multiple shortcuts, prefer one listener with `if / else if` branches

## Useful actions

- Open settings: `ctx.setActiveUi("charminal-settings")`
- Fire fireworks: `ctx.dispatchEffect({ kind: "fireworks-volley" })`
- Trigger CLAI's shortcut reaction: `ctx.emitEvent("clai:shoot", { source: "shortcut" })`

After editing, say clearly that Charminal needs a restart.
