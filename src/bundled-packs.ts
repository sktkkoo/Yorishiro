/**
 * Bundled pack imports と manifest を集約。
 * App.tsx の import line を削減し readability を改善。
 */

// Ambient UI
export { default as attentionAuraManifest } from "../bundled-packs/ambient-ui/attention-aura/manifest.json";
export { default as pomodoroUiManifest } from "../bundled-packs/ambient-ui/pomodoro-ui/manifest.json";

// Amenities
export { default as pomodoroManifest } from "../bundled-packs/amenities/pomodoro/manifest.json";

// Effects
export { default as cameraMovePack } from "../bundled-packs/effects/camera-move/effect";
export { default as cameraMoveManifest } from "../bundled-packs/effects/camera-move/manifest.json";
export { default as desaturatePack } from "../bundled-packs/effects/desaturate/effect";
export { default as desaturateManifest } from "../bundled-packs/effects/desaturate/manifest.json";
export { default as fireworksPack } from "../bundled-packs/effects/fireworks/effect";
export { default as fireworksManifest } from "../bundled-packs/effects/fireworks/manifest.json";
export { default as fireworksVolleyPack } from "../bundled-packs/effects/fireworks-volley/effect";
export { default as fireworksVolleyManifest } from "../bundled-packs/effects/fireworks-volley/manifest.json";
export { default as screenFlashPack } from "../bundled-packs/effects/screen-flash/effect";
export { default as screenShakePack } from "../bundled-packs/effects/screen-shake/effect";
export { default as screenShakeManifest } from "../bundled-packs/effects/screen-shake/manifest.json";
export { default as textPhysicsPack } from "../bundled-packs/effects/text-physics/effect";
export { default as textPhysicsManifest } from "../bundled-packs/effects/text-physics/manifest.json";

// Personas
export { default as claiEnManifest } from "../bundled-packs/personas/clai-en/manifest.json";
export { default as claiEnPack } from "../bundled-packs/personas/clai-en/persona";
export { default as claiJaManifest } from "../bundled-packs/personas/clai-ja/manifest.json";
export { default as claiJaPack } from "../bundled-packs/personas/clai-ja/persona";

// Scenes
export { default as abandonedFactoryManifest } from "../bundled-packs/scenes/abandoned-factory/manifest.json";
export { default as abandonedFactoryPack } from "../bundled-packs/scenes/abandoned-factory/scene";
export { default as mistyGrasslandsManifest } from "../bundled-packs/scenes/misty-grasslands/manifest.json";
export { default as mistyGrasslandsPack } from "../bundled-packs/scenes/misty-grasslands/scene";
export { default as simpleRoomManifest } from "../bundled-packs/scenes/simple-room/manifest.json";
export { default as simpleRoomPack } from "../bundled-packs/scenes/simple-room/scene";

// UI
export { default as charminalSettingsManifest } from "../bundled-packs/ui/charminal-settings/manifest.json";
export {
  default as charminalSettingsPack,
  PREVIOUS_ACTIVE_UI_KEY,
  resolveCloseTarget,
  SETTINGS_PACK_ID,
} from "../bundled-packs/ui/charminal-settings/ui";
export { default as immersiveManifest } from "../bundled-packs/ui/immersive/manifest.json";
export { default as immersivePack } from "../bundled-packs/ui/immersive/ui";
export { default as theaterManifest } from "../bundled-packs/ui/theater/manifest.json";
export { default as theaterPack } from "../bundled-packs/ui/theater/ui";
