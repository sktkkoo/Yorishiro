# bundled-packs/ — Bundled packs and shared assets

> Read this file when you want to confirm **what bundled packs exist and how to treat them** (layout / immutability / fork stance). Audience: dev / AI / pack authors.
> For how to write a pack, see [../src/sdk/README.md](../src/sdk/README.md). The breakdown of pack kinds (the six: persona / amenity / effect / scene / ui / ambient-ui) is at the top of that doc.
>
> 日本語版はこちら: [README.md](README.md)

The **standard packs** and **shared assets** bundled with Yorishiro. They also serve as reference implementations for pack authors.

---

## Layout

Bundled packs use a **kind-first** layout (grouped by kind):

```
bundled-packs/
├── personas/
│   ├── clai-en/             — flagship persona (English)
│   ├── clai-ja/             — flagship persona (Japanese)
│   └── clai-shared/         — common factory imported by both personas
├── amenities/
│   ├── music-shelf/         — Apple Music control (MCP tools)
│   └── pomodoro/            — pomodoro timer
├── scenes/
│   ├── simple-room/         — default scene (R3F component scene)
│   ├── misty-grasslands/    — Three.js procedural meadow scene
│   └── abandoned-factory/   — R3F-component abandoned-factory scene
├── effects/
│   ├── screen-shake/        — DOM shake on error
│   ├── screen-flash/        — white flash
│   ├── camera-move/         — temporary shift of camera position / look target
│   ├── fireworks/           — a single firework
│   ├── fireworks-volley/    — repeated fireworks
│   ├── desaturate/          — grayscale the screen
│   ├── text-physics/        — collapse / restore of terminal glyphs
│   └── abandoned-monitor/   — abandoned-surveillance-terminal-style ARG overlay
├── ui/
│   ├── yorishiro-settings/  — settings screen (opens with F1)
│   ├── immersive/           — transparent terminal UI
│   └── theater/             — fullscreen character view
├── ambient-ui/              — overlay packs (multi-active)
│   ├── attention-aura/      — visualizes gaze tracking as an overlay
│   └── pomodoro-ui/         — bottom-right display of the pomodoro timer
└── shared/                  — shared asset library
    ├── animations/          — VRMA (gitignored, fetched from an external store)
    ├── voices/              — voice placeholder (empty for now, contents .gitignore'd)
    ├── bodies/              — VRM (placeholder, user import)
    └── sounds/              — ambient sound library (referenced from a Scene Pack's ambient declaration)
```

> User packs use a symmetrically **flat layout** (`~/.yorishiro/packs/<id>/<kind>.js`). Don't confuse the two.

---

## List of bundled packs

### personas/clai-en, clai-ja
- **Entry**: `persona.ts`
- **Files**: `manifest.json`, `README.md`, `persona.md` (design memo)
- **Role**: the flagship reference for the SDK. AIs / users writing a new persona pack **read this to grasp the patterns**
- **Per-language split**: `clai-en` defaults to English, `clai-ja` to Japanese. Shared parts such as reaction definitions are imported by both from `personas/clai-shared/persona-factory.ts`
- **Main reactions**: `startled`, `contemplative`, `pleased`, `distressed`, `curious`, and others
- Details: each pack's `README.md`

### personas/clai-shared
- **Entry**: none (a shared module, not a pack)
- **Files**: `persona-factory.ts`
- **Role**: the persona-construction factory imported by `clai-en` / `clai-ja`. It provides the shared skeleton of reactions / handlers and takes language-specific voice / wording as arguments

### amenities/music-shelf
- **Entry**: `amenity.ts`
- **Files**: `manifest.json`, `README.md`
- **Role**: exposes remote control of macOS Apple Music to the inhabitant as MCP tools (play / pause / skip / search / queue / volume fade / sleep timer). The capability for the inhabitant to autonomously "play BGM", "change the track", etc.
- Details: `bundled-packs/amenities/music-shelf/README.md`

### amenities/pomodoro
- **Entry**: `amenity.ts`
- **Files**: `manifest.json`, `README.md`
- **Role**: holds the pomodoro timer's state as an amenity. It does twin-trigger co-emission with the `pomodoro-ui` ambient-ui pack — e.g. dimming the terminal during breaks (the canonical structure where the amenity holds state and the ui holds the view)

### scenes/simple-room
- **Entry**: `scene.tsx` (R3F component scene)
- **Files**: `manifest.json`, `README.md`, `lib/backdrop.tsx`, `lib/lights.tsx`, `tsconfig.json`
- **Role**: the Phase 1 default scene. A minimal reference that assembles background + foreground + lighting with R3F components. The minimal configuration with backdrop / lights split into `lib/`
- Details: `bundled-packs/scenes/simple-room/README.md`

### scenes/misty-grasslands
- **Entry**: `scene.tsx`
- **Files**: `manifest.json`, `README.md`, `lib/lights.tsx`, `tsconfig.json`
- **Role**: a high-fidelity scene using the runtime's built-in Three.js procedural renderer. It draws morning light, a distant mountain range, wind-swept grass, and light particles with no external image / video assets
- Details: `bundled-packs/scenes/misty-grasslands/README.md`

### scenes/abandoned-factory
- **Entry**: `scene.tsx`
- **Files**: `manifest.json`, `README.md`, `lib/` (a full set of procedural shaders / lights / props / post-process / camera rig), `assets/` (user-provided GLTF)
- **Role**: an abandoned-factory R3F-component scene. The place where CLAI once passed by someone — someone like another version of itself
- Details: `bundled-packs/scenes/abandoned-factory/README.md`
- Internal design: `../Yorishiro-design-record/specs/2026-05-03-abandoned-factory-scene-design.md`

### effects/screen-shake
- **Entry**: `effect.ts`
- **Role**: built-in DOM shake on error. Called from a persona via `ctx.space.injectEffect({ kind: "screen-shake" })`
- Details: `bundled-packs/effects/screen-shake/`

### effects/screen-flash
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **Role**: flashes the whole screen white for an instant. An expression of discovery, insight, or a strong reaction

### effects/camera-move
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **Role**: temporarily shifts the scene's camera position / look target. Combined with an R3F scene pack, it creates viewpoint moves / cut-in-style staging

### effects/fireworks
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **Role**: launches a single burst of fireworks onto an overlay canvas. Called from a persona / init.js via `ctx.space.injectEffect({ kind: "fireworks", origin, count, durationMs })`. For repeated bursts, use `fireworks-volley` or stagger dispatches on the caller side

### effects/fireworks-volley
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **Role**: repeated fireworks. It calls the `fireworks` pack n times internally, scattering each burst's position within a random range and adding jitter to the launch intervals. A single `ctx.dispatchEffect({ kind: "fireworks-volley" })` runs the default 3-burst volley, so the init.js boilerplate is just this one line

### effects/desaturate
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **Role**: a CSS filter effect that grayscales the whole screen. Called from a persona / init.js via `ctx.space.injectEffect({ kind: "desaturate", durationMs, intensity? })`. An expression of "silence" / "stagnation" during idle or on error

### effects/text-physics
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **Role**: an effect where the terminal's glyphs collapse under gravity and restore to their original positions. DOM-based rendering with `addDomLayer` + `queryTerminalCells`. 4 phases: hold → cascade → rest → restore

### effects/abandoned-monitor
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`, `effect.test.ts`
- **Role**: a fullscreen ARG overlay styled like an abandoned surveillance terminal. With `addDomLayer` it renders a background / scanlines / typewriter + glitch text, and arbitrary text can be streamed through the `lines` option

## ui/

UI packs (the 5th pack kind). Single-active; they define the whole of Yorishiro's UI. Details in the internal design-record: `2026-04-21-ui-pack-single-active.md` (unstable until Plan 3 is complete, so not yet promoted to the public docs/decisions/).

- **yorishiro-settings** — Yorishiro's settings screen (the entry point for avatar / persona / scene / agent / shortcut). Opens via F1 (an init.js seed binding) or the sidebar
- **immersive** — UI that makes the terminal background transparent and lets the character and scene show through in front
- **theater** — fullscreen character view. Hides the terminal / chrome and leaves only the character and scene

## ambient-ui/

Ambient UI packs (the 6th pack kind). They don't occupy the primary UI; a **multi-active** overlay layer where multiple packs can stack. `ambient-ui-pack-registry` manages enable / disable / getActiveSet.

- **attention-aura** — subscribes to `AttentionSnapshot` and draws a light band as a canvas overlay over the rect of the attended target
- **pomodoro-ui** — visualizes the state of `amenities/pomodoro` as a timer / controls at the bottom-right of the screen (the reference for the canonical structure of twin-trigger co-emission with an amenity)

---

## shared/ — Shared assets

An asset library referenceable from multiple packs. VRM / VRMA / voice files.

### animations/
- VRMA animation files
- The files themselves are subject to `.gitignore` (`bundled-packs/shared/animations/*.vrma`). During dev, `npm run fetch-assets` copies them from an external store

### voices/
- Currently an empty placeholder (just a `.gitkeep` + an empty `manifest.json`). Its entire contents are subject to `.gitignore`
- The intent: once voice distribution is decided, place WAVs by category (`acknowledge` / `thinking` / `working` / `done` / `error` / `longwork`, etc.) and declare each voice's `group` in `manifest.json`

### bodies/
- VRM character files. Currently just a `.gitkeep` placeholder (the intent is for the user to import at runtime)

### sounds/
- A shared ambient sound library. Referenced from a Scene Pack's `ambient` declaration via `'sound:<name>'`
- Layout: flat root (general) + one-level namespace (pack-specific). Details in `shared/sounds/README.md`
- Extensions: `mp3` / `wav` / `ogg` / `m4a`

---

## The "bundled is part of the core, not editable" principle

bundled-packs are treated as part of the Yorishiro core:

- **Not writable** from Yorishiro (via AI / via `/yori` / via the file writer — all of them)
- Overwritten on version upgrade
- If a user wants to modify one, they **fork** it into `~/.yorishiro/packs/<id>/` and modify there (the ELPA stance)
- A user fork is the user's responsibility (if it breaks, Yorishiro takes no responsibility)

---

## Asset supply path

During development, the VRMA / voice assets are copied from an **external store** (`../Yorishiro-assets/`, assumed to be in the parent dir) via `npm run fetch-assets`. Run automatically by the `predev` / `prebuild` hooks.

The external store's path can be overridden with the `YORISHIRO_ASSETS_DIR` environment variable.

---

## Related docs

- For pack authors: [../src/sdk/README.md](../src/sdk/README.md)
- Constraints (PTY / amenity / synthetic event): [../docs/decisions/critical-constraints.md](../docs/decisions/critical-constraints.md)
- design-record (the three pack axes = persona / amenity / effect are fixed; utility is superseded by amenity): `../Yorishiro-design-record/2026-04-11-design-exploration.md` revelations 3.12, 3.15
- design-record (addition of the scene pack = declarative, single-active): `../Yorishiro-design-record/specs/2026-04-18-scene-pack-registry.md`
