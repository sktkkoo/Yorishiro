# Credits

Charminal exists because of the work that came before it — built, published, and shared. This document records the OSS, specifications, and assets that Charminal depends on.

*This document is a living record. If you find anything missing or incorrect, please open an issue.*

---

## Runtime dependency

### Claude Code

Charminal launches [**Claude Code**](https://claude.com/claude-code) (Anthropic) via PTY and observes its behavior. Claude Code is not bundled with Charminal — the user's own installed instance is used.

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

#### CLAI (bundled default character)

Character design and VRM model by LUCAS ([@lucas_VTuber](https://x.com/lucas_VTuber)).

Copyright in this model has been transferred to the Charminal project. Moral rights remain with LUCAS.

We are deeply grateful for the exceptional design and craftsmanship that brings CLAI to life.

> LUCAS is not affiliated with the Charminal project in any way.
> Please do not contact them regarding this application or any issues related to it.

### VRMA animations

Third-party assets stored outside the repo (`../Charminal-assets/animations/`) and copied to `public/animations/` at build time for inclusion in the application bundle. Raw files are not placed in the git repository.

#### `VRMA_01.vrma` – `VRMA_07.vrma`

> **Character Animation by pixiv Inc. / VRoid Project**

- Source: [VRM Animation 7-clip set (.vrma) — VRoid Project (BOOTH)](https://booth.pm/ja/items/5512385)
- Terms: Commercial use permitted (individuals and companies), modification permitted. **The above credit is required** (intended to be displayed in the app's About / Credits screen).
- **Redistribution of extracted files is prohibited** — placing raw files in a public git repo is not permitted. Embedding in an application bundle is permitted (as the files are not separately accessible as a standalone asset pack).

#### Rokoko "10 Free Everyday Idle Animations"

`Idle Arguing.vrma` / `Idle Chatting.vrma` / `Idle Chatting 2.vrma` / `Idle Conversation.vrma` / `Idle Leaning On Wall.vrma` / `Idle Listening To Music.vrma` / `Idle Looking Around.vrma` / `Idle Looking Around 2.vrma` / `Idle Pointing.vrma` / `Idle Watching Something.vrma`

- Source: [Rokoko — 10 Free Everyday Idle Animations](https://www.rokoko.com/resources/rokoko-mocap-10-free-everyday-idle-animations) (motion capture by Sam Lazarus / Marco Mori / Jon Noorlander)
- Terms: Subject to the [Rokoko Studio EULA v2](https://cdn.rokoko.com/legal/rokoko-studio/rokoko_studio_eula_v2.pdf). Commercial use in finished products is permitted. **Redistribution of raw animation files is prohibited** — placing raw files in a public git repo is not permitted; embedding converted data in an application bundle as an integrated component is permitted. No explicit attribution requirement exists in the EULA, but we credit the source and capture artists here out of courtesy.
- Note: Original FBX files converted to VRMA format via VRMAConverter.

#### Mixamo-derived VRMA clips

`Angry.vrma` / `Button Pushing.vrma` / `Idle.vrma` / `Jog In Circle.vrma` / `Leaning.vrma` / `Right Turn.vrma` / `Talking On Phone.vrma` / `Thankful.vrma` / `Typing.vrma`

- Source: Animations from [Adobe Mixamo](https://www.mixamo.com/) converted to VRMA format.
- Terms: Subject to the Mixamo ToS. Signed-in users may use animations in personal and commercial projects. Redistribution of files as standalone assets is not permitted — placing raw files in a public git repo is not permitted; embedding in an application bundle is permitted.

### Fonts / icons

- Tauri default icon: `src-tauri/icons/` — from the [Tauri template](https://github.com/tauri-apps/create-tauri-app) (MIT / Apache-2.0). To be replaced with a Charminal-specific icon in the future.

---

## Inspiration / prior art

- Claude Code (Anthropic) — the system Charminal gives a body to
- VRoid / VRM ecosystem (pixiv / VRM Consortium) — the foundation for character expression
- Emacs — for the user-extensible runtime model and the `init.el` pattern (`~/.charminal/init.js` is its direct lineage)
- VRChat — UGC platform built around 3D avatar-mediated presence; "inhabiting a virtual space"
- [@kensyouen_Y](https://x.com/kensyouen_Y/status/1820748563338637581) — A video of a character inside Blender grabbing and manipulating the UI, moving panels on their own, even changing their own hair color. A major inspiration for ICI: the character operating the environment that contains them.
- [Caramel Pain / Hoshimachi Suisei (official)](https://www.youtube.com/watch?v=UpEPkPg8YP4) — A music video where Suisei, drawn inside an illustration tool, destroys the tool's UI and breaks out of the application to wreak havoc. Another major inspiration.

---

## Acknowledgements

*Charminal depends on countless OSS projects and assets beyond those listed here. We are grateful to all of them.*
