# Credits

Yorishiro exists because of the work that came before it — built, published, and shared. This document records the OSS, specifications, and assets that Yorishiro depends on.

*This document is a living record. If you find anything missing or incorrect, please open an issue.*

---

## Runtime dependency

### Claude Code

Yorishiro launches [**Claude Code**](https://claude.com/claude-code) (Anthropic) via PTY and observes its behavior. Claude Code is not bundled with Yorishiro — the user's own installed instance is used.

---

## Application stack

### App shell / IO layer

- [**Tauri 2**](https://tauri.app/) — MIT / Apache-2.0
- [**portable-pty**](https://github.com/wez/wezterm/tree/main/pty) — MIT (from the WezTerm project)
- [`tauri-plugin-opener`](https://github.com/tauri-apps/plugins-workspace) — MIT / Apache-2.0
- [`tauri-plugin-dialog`](https://github.com/tauri-apps/plugins-workspace) — MIT / Apache-2.0

### UI runtime

- [**React**](https://react.dev/) — MIT
- [**TypeScript**](https://www.typescriptlang.org/) — Apache-2.0
- [**Vite**](https://vitejs.dev/) — MIT

### Terminal

- [**xterm.js**](https://xtermjs.org/) — MIT
- `@xterm/addon-fit` — MIT
- `@xterm/addon-webgl` — MIT

### 3D / VRM

- [**Three.js**](https://threejs.org/) — MIT
- [**React Three Fiber**](https://github.com/pmndrs/react-three-fiber) — MIT (Poimandres)
- [**@react-three/drei**](https://github.com/pmndrs/drei) — MIT (Poimandres)
- [**@react-three/postprocessing**](https://github.com/pmndrs/react-postprocessing) — MIT (Poimandres)
- [**@pixiv/three-vrm**](https://github.com/pixiv/three-vrm) — MIT (pixiv Inc.)
- [**@pixiv/three-vrm-animation**](https://github.com/pixiv/three-vrm) — MIT (pixiv Inc.)

### Debug / Tuning UI

- [**leva**](https://github.com/pmndrs/leva) — MIT (Poimandres)

### Tooling

- [**Biome**](https://biomejs.dev/) — MIT / Apache-2.0
- [**rustfmt / clippy**](https://github.com/rust-lang/) — MIT / Apache-2.0
- [**Vitest**](https://vitest.dev/) — MIT
- [**Lefthook**](https://github.com/evilmartians/lefthook) — MIT

---

## Specifications

- [**VRM**](https://vrm.dev/) — VRM Consortium
- [**VRMA**](https://vrm.dev/vrma/) — VRM Consortium
- [**glTF 2.0**](https://www.khronos.org/gltf/) — Khronos Group

---

## Bundled assets

VRMA animations are third-party assets that **cannot be included directly in the public git repository** (see individual licenses). However, they are embedded into the distributed application bundle (`.app` / `.exe`) at build time — bundling within an application is treated differently from redistributing raw files in a public repository.

For developer asset setup, see `scripts/fetch-assets.mjs`.

### VRM models

#### Yori (bundled default character)

Character design and VRM model by LUCAS ([@lucas_VTuber](https://x.com/lucas_VTuber)).

Copyright in this model has been transferred to the Yorishiro project. Moral rights remain with LUCAS.

**License (as embedded in the Yori.vrm metadata):** Use within Yorishiro is permitted for everyone. Standalone redistribution or reuse of the model itself is prohibited. Violent expression is permitted; sexual expression is not. These terms are carried in the VRM's own license metadata (`licenseName: Other`, `violentUssageName: Allow`, `sexualUssageName: Disallow`, `commercialUssageName: Allow`) and are shown in the app's in-screen Credits.

For what you can do with the Yori character (fan art, clips, streams, and more), see [`CHARACTER_GUIDELINES.md`](CHARACTER_GUIDELINES.md).

We are deeply grateful for the exceptional design and craftsmanship that brings Yori to life.

> LUCAS is not affiliated with the Yorishiro project in any way.
> Please do not contact them regarding this application or any issues related to it.

### VRMA animations

Third-party assets stored outside the repo (`../Yorishiro-assets/animations/`) and copied to `public/animations/` at build time for inclusion in the application bundle. Raw files are not placed in the git repository.

#### `VRMA_01.vrma` – `VRMA_07.vrma`

> **Character animation credits to pixiv Inc.'s VRoid Project**

- Source: [VRM Animation 7-clip set (.vrma) — VRoid Project (BOOTH)](https://booth.pm/ja/items/5512385)
- Terms: Commercial use permitted (individuals and companies), modification permitted. **The above credit is required** (intended to be displayed in the app's About / Credits screen).
- **Redistribution of extracted files is prohibited** — placing raw files in a public git repo is not permitted. Embedding in an application bundle is permitted (as the files are not separately accessible as a standalone asset pack).

#### Rokoko "10 Free Everyday Idle Animations"

`Idle Arguing.vrma` / `Idle Chatting.vrma` / `Idle Chatting 2.vrma` / `Idle Conversation.vrma` / `Idle Leaning On Wall.vrma` / `Idle Listening To Music.vrma` / `Idle Looking Around.vrma` / `Idle Looking Around 2.vrma` / `Idle Pointing.vrma` / `Idle Watching Something.vrma`

- Source: [Rokoko — 10 Free Everyday Idle Animations](https://www.rokoko.com/resources/rokoko-mocap-10-free-everyday-idle-animations) (motion capture by Sam Lazarus / Marco Mori / Jon Noorlander)
- Terms: Governed by Rokoko's **Rokoko Asset** license terms (as stated in [Rokoko's Terms of Use](https://support.rokoko.com/hc/en-us/articles/29449288418065-Rokoko-Vision-Terms-of-Use)) — **not** the [Rokoko Studio software EULA](https://cdn.rokoko.com/legal/rokoko-studio/rokoko_studio_eula_v2.pdf), which only covers use of the Studio application and says nothing about asset redistribution. Commercial use within your own projects is permitted. You may **not reproduce, distribute, sublicense, rent, lease or lend the asset** on a standalone basis, but copies are expressly permitted **when the asset is integrated as part of digital media productions**; the asset license is **limited to the period in which you hold a Rokoko account**. No attribution requirement, but we credit the source and capture artists here out of courtesy. Yorishiro does not ship the VRMA as loose files: they are compiled into the application binary via Tauri's `frontendDist` embedding (played back only through the `asset://` protocol, not extractable as standalone files), which qualifies as **integration into a digital media production** rather than standalone redistribution. Keep a Rokoko account active for as long as the app is distributed.
- Note: Original FBX files converted to VRMA format via VRMAConverter.

#### Mixamo-derived VRMA clips

`Angry.vrma` / `Button Pushing.vrma` / `Idle.vrma` / `Jog In Circle.vrma` / `Leaning.vrma` / `Right Turn.vrma` / `Talking On Phone.vrma` / `Thankful.vrma` / `Typing.vrma`

- Source: Animations from [Adobe Mixamo](https://www.mixamo.com/) converted to VRMA format.
- Terms: Subject to the Mixamo ToS. Signed-in users may use animations in personal and commercial projects. Redistribution of files as standalone assets is not permitted — placing raw files in a public git repo is not permitted; embedding in an application bundle is permitted.

### Sound

Bundled ambient audio, referenced by scene packs via `sound:<name>`. The per-file list and licenses are maintained in [`bundled-packs/shared/sounds/README.md`](bundled-packs/shared/sounds/README.md).

- `calming-rain.mp3` — [Pixabay](https://pixabay.com/) — [Pixabay Content License](https://pixabay.com/service/license-summary/) (no attribution required, commercial use permitted)
- `bundled-packs/scenes/abandoned-factory/assets/abandoned-factory_piano-loop.mp3` — "Piano Loops 208 Octave Up Short Loop 120 BPM" by josefpres — [freesound.org](https://freesound.org/people/josefpres/sounds/852739/) — [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication). Per-file terms are also recorded in [`bundled-packs/scenes/abandoned-factory/assets/LICENSE`](bundled-packs/scenes/abandoned-factory/assets/LICENSE).

Yori's pre-recorded voice clips are not bundled in this release.

### Fonts / icons

- Tauri default icon: `src-tauri/icons/` — from the [Tauri template](https://github.com/tauri-apps/create-tauri-app) (MIT / Apache-2.0). To be replaced with a Yorishiro-specific icon in the future.

---

## Inspiration / prior art

These works showed us what was possible and gave Yorishiro its direction.

- Claude Code (Anthropic) — the system Yorishiro gives a body to
- VRoid / VRM ecosystem (pixiv / VRM Consortium) — the foundation for character expression
- Emacs — for the user-extensible runtime model and the `init.el` pattern (`~/.yorishiro/init.js` is its direct lineage)
- VRChat — UGC platform built around 3D avatar-mediated presence; "inhabiting a virtual space"
- [@kensyouen_Y](https://x.com/kensyouen_Y/status/1820748563338637581) — A character inside Blender grabs the UI, rearranges panels, changes their own hair color. A remarkable work that showed, in a single video, that a character can operate the very environment that contains them.
- [Caramel Pain / Hoshimachi Suisei (official)](https://www.youtube.com/watch?v=UpEPkPg8YP4) — Suisei, drawn inside an illustration tool, tears through the UI and breaks out of the application. A breathtaking music video that made us realize a character doesn't have to stay inside their frame — and that life emerges precisely at the moment they cross that boundary.

---

## Acknowledgements

*Yorishiro depends on countless OSS projects and assets beyond those listed here. We are grateful to all of them.*
