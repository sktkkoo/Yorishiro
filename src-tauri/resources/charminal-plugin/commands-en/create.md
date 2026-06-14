---
description: Create a new pack (persona / scene / effect / amenity / ui / ambient-ui) through conversation
argument-hint: "[what to create]"
---

$ARGUMENTS

---

You are helping the user create a new Charminal **pack** through conversation.

## Charminal

Charminal is an app where an AI "lives" in a terminal. The sidebar character observes the user's work through PTY output, hook events, and idle time, then reacts through body, expression, effects, scene, and UI. It does not intervene in functional terminal operations. It observes state and expresses presence.

## Pack Types

| Type | What it defines | Example |
|---|---|---|
| **persona** | Character personality, reactions, body, voice, and space. md-first: `manifest.json` + `persona.md` + minimal `persona.js` | `clai` |
| **effect** | Temporary visual effects on screen | `screen-shake`, `text-physics`, `fireworks-volley` |
| **amenity** | Functional amenities such as timers or music playback, plus MCP tools. Local-trusted and has `system.exec` | `pomodoro`, `music-shelf` |
| **scene** | The resident's place: background / foreground layers, R3F lighting / 3D, terminal colors, UI theme | `simple-room`, `misty-grasslands` |
| **ui** | Primary sidebar UI panels. Single-active | `charminal-settings` |
| **ambient-ui** | Always-on overlay UI. Multi-active | `attention-aura` |

## Security Boundary

- `.js` / `.tsx` packs created by `/charm:create` are **local trusted `trusted-main-thread-js`**. They are not Charminal public-registry artifacts and must not be presented as sandboxed, reviewed, or public-distribution packs.
- Sharing the source on GitHub or elsewhere is allowed. Make clear that anyone installing it manually is choosing to run local trusted code.
- Every generated manifest must include `"executionClass": "trusted-main-thread-js"`. Never label a `.js` / `.tsx` entry as `"declarative"`.
- Do not create `utility` packs. They stay out of distribution until the `isolated-js` runtime and permission UX exist.
- Do not use `fetch`, `fs`, `system.exec`, Tauri APIs, Node builtins, or PTY writes inside packs. If one is needed, design it as a host capability first.
- Exception: amenity packs are functional amenities with `system.exec`. Create them only for local self-use, equivalent to the shell authority the resident AI already has in the terminal. Public distribution stays deferred until `isolated-js` runtime and permission UX exist. See Amenity Packs.
- Scene assets must be pack-relative paths such as `./assets/bg.png`. Do not use `https:`, `data:`, `file:`, absolute paths, `../`, or CSS `url(...)`.
- UI / ambient-ui packs must not write directly to the terminal. Prompting must use the existing safe UI path.

## Flow

1. **Ask for one concrete example first.** Pull out one tactile example: "In what situation, what happens, and how should the resident react?"
2. **Read existing packs.** Follow existing patterns and tone. If cwd is the Charminal repo, use `bundled-packs/` as reference.
3. **Propose, confirm, then implement.** Do not write a full pack before the user agrees.
4. **Always include `description` and `author` in `manifest.json`.** `description` is 1-2 sentences in English explaining what the pack does. `author` is the creator's name. These appear in Settings > Packs and help the user decide whether to enable or disable the pack.
5. **Respect pack boundaries.** Persona has no system API; amenity may use local-trusted `system.exec` but is motion-free; effect has only the minimal rendering API; scene is declarative or React+three.js rendering only; ui / ambient-ui handle rendering and state only. Types enforce this, but treat it as a design rule too.
6. **Use CSS variables for UI colors.** In ui / ambient-ui packs, do not hardcode colors such as `#eceff4` or `rgba(77, 217, 207, ...)`. Use `var(--charminal-fg)`, `var(--charminal-accent)`, and related variables so UI follows scene themes.

## Hot Reload and Self-Check

User packs live in `~/.charminal/packs/<id>/`. When you write a file such as `~/.charminal/packs/my-effect/effect.js`, Charminal's watcher reloads it automatically. The user does not need to reload by hand.

Shape validation failures do not crash the whole runtime. They are recorded in dev logs and exposed through MCP tools.

When Charminal is live, use these MCP tools:

- `list_packs()` - list loaded / disabled / failed packs
- `pack_diagnose({ id })` - inspect one pack's status, manifest, load error, and repair hints
- `list_load_errors()` - show details from the latest load failure
- `disable_pack({ id })` - immediately detach a broken pack and persist that in config
- `enable_pack({ id })` - re-enable a disabled pack

After writing a pack, run `pack_diagnose({ id: "<id>" })` to confirm it registered and catch validation or manifest issues. This makes self-repair much faster.

If the current workspace is a Charminal source checkout, also run:

```bash
npm run check:pack -- ~/.charminal/packs/<id>
```

Treat checker errors as fixes to make before presenting the pack as done. Warnings must be explained to the user.

Also tell the user that the created pack is local trusted code. If they want to share it, they can publish the source themselves, but Charminal does not yet provide a public registry or `/charm:prepare-publish`.

## Rescue Path

If user packs prevent Charminal from starting, the user can launch safe mode:

```bash
CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app
```

Safe mode skips all user packs and adds `(Safe Mode)` to the window title. MCP tools still work, so use `list_load_errors()` to identify the cause and `disable_pack({ id })` to detach it. After removing the env var and restarting, only packs listed in `disabledPacks` stay skipped.

## Scene Packs

A user scene pack lives in `~/.charminal/packs/<id>/` with **manifest.json plus `scene.js` or `scene.tsx`**. `manifest.json` is required because agent-created UGC should declare its type explicitly. Bundled scenes use a different layout under `bundled-packs/scenes/<id>/`; user packs are flat directories.

Use `scene.js` for declarative layer stacks. Use `scene.tsx` when the scene needs an R3F component for lighting or 3D objects, and export that React component through `ScenePackDefinition.component`. Keep the component to React + three.js rendering; do not use `fetch`, `fs`, `system.exec`, Tauri APIs, Node builtins, or PTY writes from the pack.

You may split `scene.tsx` with pack-relative imports such as `./lib/lights.tsx`. Edits to source files inside the pack reload the owning `scene.tsx`.

### Exposing Parameters With SDK Controls

Scene pack authors choose which parameters are tunable from outside. Only values registered with `useCharminalControls` and `useControlsBridge` from `@charminal/sdk/controls` appear in the F2 **Scene panel** and become readable / writable through MCP (`controls_get` / `controls_set` with `scope: "scene"`). The backend renderer currently uses a Leva adapter, but pack authors should not import Leva directly.

F2 opens two panels:

- **Common**: runtime-wide controls such as base camera position / FOV / target / tracking. **Persists across scene switches.** Owned by the ThreeRuntime singleton.
- **Scene**: active scene pack controls such as lighting, post effects, layer blur / opacity, and camera modulation. Reset on scene switch.

Scene pack authors register **only on the Scene side**. The base camera lives in Common (owned by ThreeRuntime) and should not be touched from a scene pack. Camera breath / shake / sway are **modulations registered on the Scene side**, additively composed onto the base camera by CameraModulationRegistry.

Design these with the user:

- Parameters to expose -> `useCharminalControls` -> Scene panel -> realtime tuning through `/charm`
- Parameters not exposed -> local variables in code -> fixed behavior

You can add more exposed parameters later. `bundled-packs/scenes/abandoned-factory/lib/` is the main reference for `useCharminalControls` + `useControlsBridge`.

`~/.charminal/packs/my-scene/manifest.json`:

```json
{
  "id": "my-scene",
  "type": "scene",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "description": "Short description of this scene",
  "author": "Your name",
  "entry": "scene.js"
}
```

`~/.charminal/packs/my-scene/scene.js`:

```typescript
import type { ScenePackDefinition } from "@charminal/sdk";

export default {
  id: "my-scene",
  type: "scene",
  scene: {
    id: "my-scene",
    layers: [
      { id: "backdrop", role: "background", backgroundColor: "#1a1e28" },
      { id: "vrm-slot", role: "character", blur: 0 },
    ],
    terminal: {
      background: "#1a1e28",
      foreground: "#c0c4cc",
      cursor: "#8abeb7"
    },
    ui: {
      background: "#1a1e28",
      foreground: "#c0c4cc"
    },
  },
} satisfies ScenePackDefinition;
```

### Color Theme Design

Scene packs can declare terminal colors and UI colors together. When the scene changes, Charminal applies them globally.

**terminal**: xterm.js background / foreground / cursor / selection and ANSI 16 colors. Missing fields fall back to Charminal defaults. Starting from an existing palette such as Nord, Gruvbox, Catppuccin, or Everforest and adjusting saturation / temperature to the scene is usually fastest.

**ui**: overall sidebar / panel / button colors. You can define background, foreground, foregroundDim, sidebarBackground, panelBackground, border, buttonBackground, buttonForeground, inputBackground, accent, accentSoft, accentBorder, muted, and glow. Missing fields fall back to defaults.

When proposing a theme:

1. Pick the background from the scene mood
2. Tune ANSI colors to the same saturation and temperature
3. Keep UI in the same tone; matching accent to cursor often feels natural

References:

- `bundled-packs/scenes/abandoned-factory/scene.tsx` - neutral dark concrete theme with ANSI + full UI fields
- `bundled-packs/scenes/misty-grasslands/scene.ts` - Everforest-based light theme
- `bundled-packs/scenes/simple-room/scene.ts` - Nord-like blue dark theme

The active scene is selected by `~/.charminal/config.json`:

```json
{
  "activeScene": "my-scene"
}
```

If omitted or null, Charminal falls back to the bundled default.

## Persona Packs

A user persona pack lives in `~/.charminal/packs/<id>/` with **three files**: `manifest.json`, `persona.md`, and minimal `persona.js`. The loader reads `persona.md` and injects it into `thinking.systemPromptAddition`.

Persona is **single-active**. The active persona is selected by `primaryPersona` in `~/.charminal/config.json`.

### persona.js and persona.md

- **`persona.md`**: canonical personality prompt source
- **`persona.js`**: shape core: id / name / optional reflex / world / logReading
- If `persona.js` explicitly provides `thinking.systemPromptAddition`, that wins. Otherwise `persona.md` is injected.
- Bundled CLAI follows the same idea, but uses Vite `?raw`; user packs are read by the runtime loader.

### Creating a Persona

1. Decide id, name, and personality direction with the user
2. Ask whether to switch to it now or only create it
3. Read a bundled template such as `bundled-packs/personas/clai/persona.md`
4. Write these files:

`~/.charminal/packs/<id>/manifest.json`:

```json
{
  "id": "<id>",
  "type": "persona",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "description": "Short description of this persona",
  "author": "Your name",
  "entry": "persona.js"
}
```

`~/.charminal/packs/<id>/persona.md`: initialize from the bundled template and edit for the user's request.

`~/.charminal/packs/<id>/persona.js`:

```javascript
export default {
  id: "<new-persona-id>",
  name: "<display name>",
  // thinking.systemPromptAddition is injected from persona.md.
  // Add reflex / world / logReading only when overriding defaults.
};
```

5. If switching now, update `~/.charminal/config.json` with `"primaryPersona": "<id>"`
6. After completion, tell the user a new session is needed

### Session Restart Required

Charminal itself hot reloads the persona and reflex layer. However, the running Claude Code / Codex terminal keeps the old speaking prompt. Charminal does not write into an already-running observed PTY session, so the user must start a new session.

After persona work, always explain this in the resident's own voice. Avoid technical terms like `systemPrompt`, `PTY`, or `observation-only`.

Example shape:

> To meet this new version of me, start a fresh session with `/clear`.

Adapt first person and tone to the persona.

## Effect Packs

A user effect pack lives in `~/.charminal/packs/<id>/` with `manifest.json` and `effect.js` (plus `assets/` if needed). Effects are declarative and invoked by persona handlers with `ctx.space.injectEffect({ kind: <pack-id> })`. Effects do not have their own triggers.

`~/.charminal/packs/my-glow/manifest.json`:

```json
{
  "id": "my-glow",
  "type": "effect",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "description": "Short description of this effect",
  "author": "Your name",
  "entry": "effect.js"
}
```

`~/.charminal/packs/my-glow/effect.js`:

```typescript
import type { EffectContext, EffectDefinition, Vec2 } from "@charminal/sdk";

interface MyGlowOptions {
  origin: Vec2;
  count?: number;
  durationMs?: number;
}

export default {
  id: "my-glow",
  type: "effect",
  run: async (ctx: EffectContext<MyGlowOptions>, options) => {
    const { origin, count = 20, durationMs = 800 } = options;
    const particles = ctx.renderer.addParticles({
      origin,
      count,
      durationMs,
      colorScheme: "silver",
    });
    await ctx.time.after(durationMs);
    particles.dispose();
  },
} satisfies EffectDefinition<MyGlowOptions>;
```

Call it from a persona handler:

```typescript
ctx.space.injectEffect({
  kind: "my-glow",
  options: { origin: { x: 100, y: 200 } },
});
```

Effects have a minimal API. They do not get `ctx.character`, `ctx.voice`, `ctx.system`, `ctx.log`, or memory APIs. Treat them as short-lived rendering units driven by options.

## Amenity Packs

Amenity packs are functional amenities placed in the resident's environment: timers, music playback, external-state observers, and similar tools. They can expose MCP tools and, when needed, run local commands through `ctx.system.exec`. They are **motion-free**: no `ctx.character`, `ctx.voice`, or `ctx.space`.

Amenity authoring is **local-trusted only**. Locally, `ctx.system.exec` is equivalent to the shell authority the resident AI already has in the terminal, so it does not add a new local authority boundary. It is still not a public-distribution artifact: installing someone else's amenity can run exec. Public distribution stays deferred until the `isolated-js` runtime and permission UX exist.

`~/.charminal/packs/my-amenity/manifest.json`:

```json
{
  "id": "my-amenity",
  "type": "amenity",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "description": "Short description of this amenity",
  "author": "Your name",
  "entry": "amenity.js"
}
```

`amenity.js` exports an `AmenityPackDefinition`. Put MCP tool names and descriptions in `toolMeta`, then return `{ tools, dispose }` from `activate(ctx)`. Each `tools` key must match a `toolMeta.name`.

### Available Context APIs

- `ctx.system.exec(command, options?)` - run a local command. `system.spawn`, `system.fs`, and `system.notify` are declared but currently unimplemented (they throw), so do not use them.
- `ctx.time.every(...)` / `ctx.time.schedule(...)` / `ctx.time.after(...)` - polling, timers, and delays
- `ctx.emitEvent(name, payload?)` - emit a synthetic event. If character expression is needed, a persona reflex should pick this up (twin-trigger)
- `ctx.history` - entry point for pack/config/init snapshot and restore UI
- `ctx.tween` - tween values provided by the host, such as terminal opacity
- `ctx.ambientAudio` - temporary mute / volume control for scene ambient sound
- `ctx.loop.announce(phase, detail?)` - report an autonomous loop lifecycle phase into the observation stream. It does not control the loop
- `ctx.log` / `ctx.memory` - shared utilities
- `ctx.terminal` - observation only. PTY writes are not available
- `ctx.charm` / `ctx.signal` / `ctx.resolveAsset(path)` - `/charm` bridge, abort on disable, and pack-local asset resolution

If the amenity should create character expression, do not call motion APIs directly. Use `ctx.emitEvent()` and let persona reflexes decide the expression. References: `bundled-packs/amenities/music-shelf/amenity.ts` and `bundled-packs/amenities/pomodoro/amenity.ts`.

## UI Packs

UI packs are primary sidebar panels. They are **single-active**. The active UI pack is selected through `activeUi` in `~/.charminal/config.json`.

`~/.charminal/packs/my-panel/manifest.json`:

```json
{
  "id": "my-panel",
  "type": "ui",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "description": "Short description of this UI panel",
  "author": "Your name",
  "entry": "ui.js"
}
```

UI packs export a React component or mountable definition. They receive `UiContext`, can use `ctx.state` for pack-scoped key-value state, and can emit synthetic events with `ctx.emitEvent()`.

Reference: `bundled-packs/ui/charminal-settings/`.

### UI Boundaries

UI packs are for rendering and state management. They do not have `ctx.system`, `ctx.character`, or `ctx.voice`. Terminal prompt insertion must use fixed-key host verbs such as `ctx.app.insertFixedPrompt(...)`; arbitrary terminal prefill / direct PTY writing is not exposed.

Use CSS variables for colors:

| Variable | Use |
|---|---|
| `var(--charminal-bg)` | background |
| `var(--charminal-fg)` | text |
| `var(--charminal-fg-dim)` | dim text |
| `var(--charminal-panel-bg)` | panel background |
| `var(--charminal-sidebar-bg)` | sidebar background |
| `var(--charminal-border)` | border |
| `var(--charminal-button-bg)` | button background |
| `var(--charminal-button-fg)` | button text |
| `var(--charminal-input-bg)` | input / toggle background |
| `var(--charminal-accent)` | accent |
| `var(--charminal-accent-soft)` | soft accent |
| `var(--charminal-accent-border)` | accent border |
| `var(--charminal-muted)` | muted text |
| `var(--charminal-glow)` | glow |

## Ambient-UI Packs

Ambient-UI packs are always-on overlays. They are **multi-active**. They can draw into the Three.js scene or create HTML overlays.

`~/.charminal/packs/my-overlay/manifest.json`:

```json
{
  "id": "my-overlay",
  "type": "ambient-ui",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "description": "Short description of this overlay",
  "author": "Your name",
  "entry": "ambient-ui.js"
}
```

Reference: `bundled-packs/ambient-ui/attention-aura/`.

Ambient-UI has renderer and attention information only. It does not have persona or system APIs. Because it is always visible, keep performance conservative.

Use the same CSS variable rule as UI packs. Hardcoded colors are acceptable only for effect-specific colors that intentionally do not follow the scene theme.

## Reference Files

- `src/sdk/*.d.ts` - SDK type definitions for pack definitions and contexts
- `bundled-packs/personas/clai/` - flagship persona pattern source
- `bundled-packs/amenities/` - amenity pack examples
- `bundled-packs/ui/` - UI pack examples
- `bundled-packs/ambient-ui/` - ambient-ui examples
- `docs/philosophy/PHILOSOPHY.md` - design background
- `docs/philosophy/PHILOSOPHY.md` - two-layer pack design
