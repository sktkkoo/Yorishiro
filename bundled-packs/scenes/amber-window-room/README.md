# Twilight Café

An amber-lit evening café with old window frames, jade walls, walnut furniture, paper lamps and seven flowering plants.

![Twilight Café](../../../docs/assets/twilight-cafe.png)

The saved preview uses Blender Eevee with the window glass hidden for the preview only. The shipped GLB retains its transparent glass; its appearance was verified separately in Yorishiro.

## Model and materials

`assets/room-polished.glb` is the reviewed 0.4.0 room: **73,864 triangles, 31 meshes/primitives, 31 materials and 23 embedded images**, approximately 25.01 MiB. These counts exclude the avatar. The original 236,282-triangle model was reduced by 68.74%; matching materials are consolidated.

The model includes local contact AO, textured wood and fabric, generated leaf veins, glazed ceramic vessels and a blurred courtyard image. All 284 leaves remain: actual leaf/petal intersections were corrected by rotating affected leaves and petioles, preserving natural overlap. The menu sits in front of the window frame, 5 cm above the red notice and 5.5 cm below the speaker. The hidden floor crock remains removed.

The foliage adapter adds restrained reverse-side diffuse response to directional light after shadow attenuation. It uses no extra render pass and falls back to ordinary PBR if Three.js shader chunks change. Ceramic clearcoat is authored in the GLB. A 64px environment cube is captured once per mount from local Lightformers. No external textures or decoders are required. Frame rate has not been benchmarked.

Model-cache materials, geometry and textures are never mutated or disposed by this pack; only its own material clones are disposed. The distant courtyard is unlit, while room materials use the host lighting and shadow settings.

## Placement and controls

The room uses meters and Y up; the window is toward negative Z and the camera views from positive Z. Room geometry and lighting start 1.6 m behind the resident. The avatar and Common camera remain under host control.

F2 → Scene exposes `room.distance` and the `lights` folder. Starting values are ambient 0.45, window 1.15, paper lamps 1.3 and resident fill 0.5. The parchment terminal background and dark foreground remain readable on light input/message blocks; surrounding UI stays dark jade.

## Registration and earlier local copies

Display name: **Twilight Café**. Stable pack ID: `amber-window-room`, retained so existing project selections and controls continue to work. This adds a selectable bundled scene; it does not change the fresh-install default.

An earlier same-ID local pack overrides this bundled version. Keep that working copy until a build containing Twilight Café is installed. To use the bundled copy afterward, back up the local pack outside the user packs directory, then restart the app. Removing an active local override alone does not automatically re-register its bundled counterpart.

See [asset provenance](assets/PROVENANCE.md) for the model and texture production record. Editable Blender files, source texture maps and rebuilding scripts are retained in the local `Autodesk/yorishiro-amber-room` authoring project; the runtime GLB is self-contained.
