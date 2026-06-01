/**
 * @charminal/sdk/ui-pack
 *
 * UI Pack の定義型（5 つ目の pack kind）。
 * packs/ui/<id>/ui.tsx では `satisfies UiPackDefinition` を使って export default する。
 *
 * UI Pack は Charminal の UI を丸ごと定義する single-active pack。
 * `config.json` の `activeUi` で user が picks する（feedback_single_active_config_picks）。
 * layout spec で固定要素（terminal / sidebar / character）の配置を宣言し、
 * mount で container 内に自由に React component を描画する。
 *
 * UiContext は Plan 3 で three / claim / state を追加済み。Plan 4 の
 * user UI pack .tsx transpile までは読み込み経路が限定的なため、early adopter
 * の pack 作者は小さな追加変更への追従を想定すること。
 *
 * Internal design-record: specs/2026-04-21-ui-pack-design.md
 */

import type { VRM } from "@pixiv/three-vrm";
import type * as THREE from "three";
import type { CharacterAPI, Disposable, LogAPI, SpaceAPI, Time, TweenAPI } from "./context";
import type { LayerRole, SceneSpec } from "./scene";

export type AppLanguage = "auto" | "en" | "ja";
export type ResolvedLanguage = "en" | "ja";
export type UiPresenceLevel = "default" | "closed";

/**
 * Charminal の layout を UI pack がどう変えるかの宣言。
 * 未指定フィールドは default のまま（非破壊的）。
 *
 * UiLayoutAPI.update は **full-replace semantics**：
 *   毎回 resetLayout を呼んでから partial を full layout として apply する。
 *   前回 apply した値は残らない。
 */
export interface UiLayout {
  readonly sidebar?: {
    /** "default" = 280px, "fullscreen" = 100vw, "hidden" = 0, number = px 指定 */
    readonly width?: "default" | "fullscreen" | "hidden" | number;
    /** sidebar の配置。"overlay" は terminal の上に重なる */
    readonly position?: "left" | "right" | "overlay";
    /** 背景透過 */
    readonly transparent?: boolean;
  };
  readonly terminal?: {
    /** "default" = flex:1、"bottom" = 画面下 40% に配置、"hidden" = display:none、object = 絶対配置 */
    readonly position?:
      | "default"
      | "bottom"
      | "hidden"
      | {
          readonly top: string;
          readonly left: string;
          readonly width: string;
          readonly height: string;
        };
    /** terminal 全体の不透明度 0-1。1=不透明（既定）。<1 で背後の character/scene が透ける。MCP `ui.terminal.set {opacity}` と対称。 */
    readonly opacity?: number;
    /** true で terminal の背景のみ透明化（文字は不透明のまま）。背後の character/scene が見える没入用。MCP 対称。 */
    readonly transparentBackground?: boolean;
  };
  readonly character?: {
    /** false にすると Three.js canvas を非表示 */
    readonly visible?: boolean;
  };
  readonly chrome?: {
    /** false にすると chrome 行（folder/gear, .sidebar）を非表示。"キャラだけ全画面" 等に使う */
    readonly visible?: boolean;
  };
  readonly tabIndicator?: {
    /** false にするとタブインジケータ（セッション切替の pill）を非表示。terminal が見えない全画面モード（theater 等）でタブ切替が無意味なときに使う */
    readonly visible?: boolean;
  };
  readonly transition?: {
    /** "stage" = chrome 行が上へ引っ込み → shell/character が全画面へ開く（閉じるときは逆順）アニメーション。theater 等の fullscreen pack 用。presence と同じ TweenManager で駆動 */
    readonly kind: "stage";
  };
  /**
   * AI の存在強度 / `ui.sidebar.set` 相当の mutation がどの surface を動かすかの宣言。
   *
   * これを宣言しない UI pack では presence/sidebar 系の MCP tool は
   * typed `unavailable` を AI に返す（loud-unavailable, spec §4）。
   * default-shell（host 既定 = classic）は `"shell"` を宣言するので既定では常に available。
   *
   * target は host 所有 surface registry の登録名（runtime の `SurfaceName` と同期。
   * surface-registry.test-d.ts に sync 型 assertion）。
   */
  readonly presence?: {
    readonly target: "shell" | "character" | "chrome";
  };
}

export interface UiPackManifest {
  readonly $schema?: string;
  readonly id: string;
  readonly name?: string;
  readonly type: "ui";
  readonly version: string;
  readonly charminalVersion: string;
  readonly description?: string;
  readonly executionClass?: "declarative" | "isolated-js" | "trusted-main-thread-js";
  readonly artifact?: {
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly entry: string;
}

/**
 * dropdown 用の pack 選択肢。id・name・出自を保持する。
 */
export interface UiAppPackOption {
  readonly id: string;
  readonly name?: string;
  readonly origin: "bundled" | "user";
}

export interface UiAppPackStatusEntry {
  readonly id: string;
  readonly kind: string;
  readonly origin: "bundled" | "user";
  readonly status: "loaded" | "disabled" | "failed";
  readonly isActive: boolean;
}

export interface UiAppPackDiagnosis {
  readonly id: string;
  readonly kind: string;
  readonly origin: "bundled" | "user" | "unknown";
  readonly status: "loaded" | "disabled" | "failed" | "missing";
  readonly isActive: boolean;
  readonly entryPath?: string;
  readonly manifest?: {
    readonly id: string;
    readonly type: string;
    readonly entry: string;
    readonly executionClass?: string;
    readonly description?: string;
    readonly author?: string;
  };
  readonly loadError?: {
    readonly phase: "import" | "validate";
    readonly message: string;
  };
}

export interface UiAppPackDiagnoseResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly diagnoses: readonly UiAppPackDiagnosis[];
  readonly diagnostics: readonly {
    readonly severity: "info" | "warning" | "error";
    readonly code: string;
    readonly message: string;
  }[];
  readonly recommendations: readonly string[];
}

export interface UiHealthItem {
  readonly id: string;
  readonly label: string;
  readonly status: "ok" | "warning" | "error";
  readonly detail: string;
  readonly action?: string;
}

export interface UiHealthReport {
  readonly generatedAt: string;
  readonly summary: "ok" | "warning" | "error";
  readonly selectedAgent: string;
  readonly safeMode: boolean;
  readonly homeDir: string;
  readonly paths: {
    readonly config: string;
    readonly init: string;
    readonly packs: string;
    readonly startupReport: string;
  };
  readonly items: readonly UiHealthItem[];
  readonly recommendations: readonly string[];
}

/**
 * `insertFixedPrompt` が受け付ける固定プロンプトの key。
 *
 * pack は文字列ではなくこの key を渡す。実際に terminal へ入る文言は host 所有
 * の i18n テーブルで解決される（pack はバイトを選べない）。任意テキストを
 * terminal/PTY に書く API は型ごと存在しない。
 * 設計境界: docs/decisions/input-prefill-boundary.md / critical-constraints.md §1
 */
export type FixedTerminalPromptKey = "help" | "tutorial" | "shortcut" | "create-pack" | "pomodoro";

/**
 * UI pack から App-level state を変更するための API namespace。
 * 将来 app-level の他 state を expose する余地を残すため namespace を切る。
 */
export interface UiAppAPI {
  /**
   * VRM body を切り替える。localStorage 永続化と App-level vrmPath state への
   * 反映を行う。`null` で VRM 未読み込み状態に戻す。
   */
  setVrm(path: string | null): void;
  /**
   * host 所有の固定プロンプトを terminal の入力行に pre-fill する。
   *
   * pack は `key` のみ渡し、文言は host が現在の言語で解決する。改行は付けず、
   * 実行するかどうかは user の Enter に委ねる（PTY observation only に抵触しない）。
   * 任意テキストの書き込み口は提供しない（leak 防止、対称性は固定 key 集合の側で保つ）。
   * 設計境界: docs/decisions/input-prefill-boundary.md
   */
  insertFixedPrompt(key: FixedTerminalPromptKey): Promise<void>;
  /**
   * Pack Workbench 用: 構造化された pack id/kind から、host 所有の
   * 選択中 agent に合った修正プロンプトを terminal に pre-fill する。
   * 任意テキストは受け取らない。
   */
  insertPackRepairPrompt(
    id: string,
    kind: string | undefined,
    action: "repair" | "improve",
  ): Promise<void>;
  /** 利用可能な persona pack の一覧（dropdown 用）。 */
  listPersonas(): readonly UiAppPackOption[];
  /** 利用可能な scene pack の一覧。 */
  listScenes(): readonly UiAppPackOption[];
  /** Pack Workbench 用: 現在の pack 状態一覧。 */
  listPacks(): Promise<{ readonly packs: readonly UiAppPackStatusEntry[] }>;
  /** Pack Workbench 用: 1 pack の詳細診断。 */
  diagnosePack(id: string, kind?: string): Promise<UiAppPackDiagnoseResponse>;
  /** User pack を無効化する。bundled pack は対象外。 */
  disablePack(id: string): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  /** 無効化された user pack を再読み込みして有効化する。 */
  enablePack(id: string): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  /** First-run / Diagnostics 用の host health report。 */
  getHealthReport(): Promise<UiHealthReport>;
  /** primaryPersona を切り替える。`config.json` に書き戻す責務もここ。 */
  setPrimaryPersona(id: string | null): Promise<void>;
  /** activeScene を切り替える。 */
  setActiveScene(id: string | null): Promise<void>;
  /** terminalAgent を切り替える。 */
  setTerminalAgent(agent: string): Promise<void>;
  /** Scene pack の環境音を mute / unmute する。 */
  setAmbientAudioMuted(muted: boolean): Promise<void>;
  /** activeAmbientUi の配列を置き換える。config.json に書き戻す。 */
  setActiveAmbientUi(ids: readonly string[]): Promise<void>;
  /** 環境音のマスターボリュームを設定する（0.0-1.0）。config.json に書き戻す。 */
  setAmbientAudioVolume(volume: number): Promise<void>;
  /** UI / persona fallback / command prompt の言語を切り替える。 */
  setLanguage(language: AppLanguage): Promise<void>;
  /** TTS 音声の利用頻度を設定する。次回セッションから反映。 */
  setVoiceFrequency(voiceFrequency: "on" | "off"): Promise<void>;
  /** character/sidebar の presence 表示状態を取得する。 */
  getPresenceLevel(): UiPresenceLevel;
  /** character/sidebar の presence 表示状態を切り替える。 */
  setPresenceLevel(level: UiPresenceLevel): Promise<void>;
  /**
   * 現 config の snapshot（読み取り専用、初期値表示用）。
   * `~/.charminal/config.json` を fresh に読んで返す async。
   */
  getConfig(): Promise<{
    readonly primaryPersona: string | null;
    readonly activeScene: string | null;
    /** `terminalAgent` config 値（legacy fallback）。dropdown の書き込み対象。 */
    readonly terminalAgent: string;
    /** 起動時に実際に使われる agent。`defaultProfile` が agent profile を指せば優先される。 */
    readonly effectiveAgent: string;
    /** `defaultProfile` が agent を固定しているならその profile id、なければ null。 */
    readonly agentPinnedByProfile: string | null;
    readonly ambientAudioMuted: boolean;
    readonly ambientAudioVolume: number;
    readonly activeAmbientUi: readonly string[];
    readonly language: AppLanguage;
    readonly resolvedLanguage: ResolvedLanguage;
    readonly voiceFrequency: "on" | "off";
  }>;
}

/**
 * UI pack の mount context（Plan 3 時点の shape）。
 *
 * - space: existing SpaceAPI（injectEffect 等）を再利用
 * - character: existing CharacterAPI（express / play / gaze）を再利用
 * - three: Three.js オブジェクトを直接操作（camera / scene / renderer / vrm）
 * - claim: 本体の自動処理を一時 suspend（camera tracking / expression / animation）
 * - scene: active scene pack の layer surface を一時的に調整
 * - state: MCP bridge と共有する key-value state
 * - layout: runtime で layout を変更する API
 * - app: App-level state への bridge（VRM 切替など）
 * - signal: pack deactivate 時に fire する AbortSignal
 */
export interface UiContext {
  readonly space: SpaceAPI;
  readonly character: CharacterAPI;
  readonly three: UiThreeAPI;
  readonly claim: UiClaimAPI;
  readonly scene: UiSceneAPI;
  readonly state: UiStateAPI;
  readonly time: Time;
  readonly log: LogAPI;
  readonly signal: AbortSignal;
  readonly layout: UiLayoutAPI;
  /** App-level state への bridge（VRM 切替など）。 */
  readonly app: UiAppAPI;
  /** Per-frame parameter 補間。pack dispose 時に自動 cancel される。 */
  readonly tween: TweenAPI;
  /**
   * persona / amenity の trigger に synthetic event を流す。
   * `CharminalInitContext.emitEvent` と同 shape。
   */
  emitEvent(name: string, payload?: unknown): void;
}

/**
 * Three.js オブジェクトへの live 参照。pack は `.position.set(...)` のように
 * 直接 mutate してよい。ただし「本体の自動処理と衝突するもの」（camera tracking、
 * 呼吸、表情）は `ctx.claim.xxx()` で本体の更新を止めてから触ること。
 *
 * vrm は load 前は null、load 後に非 null。現状 vrm 入れ替えは想定しない。
 */
export interface UiThreeAPI {
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly vrm: VRM | null;
  /** カメラ自動追従の有効/無効を設定。claim とは独立した app-level の設定。 */
  setCameraTracking(enabled: boolean): void;
  getCameraTracking(): boolean;
}

/**
 * 本体の自動処理を suspend する claim API。
 *
 * 各 method は Disposable を返し、dispose で release する。UI pack が
 * deactivate される（signal abort）と、pack 内の Disposable は一斉に
 * dispose される責務を pack 作者が持つ。万が一漏れても App.tsx の
 * cleanup path で強制 release される（safety net）。
 *
 * 対象：
 *   - camera: ThreeRuntime の head tracking（`camera.position.y` 追従 + `lookAt`）
 *   - expression: Body の express slot 解決 + VRM expressionManager への反映
 *   - animation: Body の animationPlayer.update + proceduralBones.update（呼吸 / head drift / VRMA）
 *
 * ※ lighting は Plan 2 時点では hard-code のため claim 対象外。scene 経由で直接操作する。
 */
export interface UiClaimAPI {
  camera(): Disposable;
  expression(): Disposable;
  animation(): Disposable;
  /** 指定 kind が現在 claim 済みかを返す。 */
  isClaimed(kind: "camera" | "expression" | "animation"): boolean;
}

export interface UiSceneLayerTarget {
  readonly role?: LayerRole;
  readonly id?: string;
}

export interface UiSceneLayerPatch {
  readonly src?: string | null;
  readonly mediaType?: "image" | "video" | null;
  readonly backgroundColor?: string | null;
  readonly backgroundImage?: string | null;
  readonly blur?: number | null;
  /** 0-1。null でリセット（= 1 に戻る）。 */
  readonly opacity?: number | null;
}

export interface UiSceneAPI {
  get(): SceneSpec | null;
  subscribe(listener: (scene: SceneSpec | null) => void): Disposable;
  updateLayer(target: UiSceneLayerTarget, patch: UiSceneLayerPatch): void;
  resetLayer(target: UiSceneLayerTarget): void;
  resetAll(): void;
}

/**
 * UI pack と Claude Code（MCP）をつなぐ key-value state。
 *
 * この API は active UI pack ごとに scope される。pack A の `camera.x` と
 * pack B の `camera.x` は別値として保持される。MCP からは packId 省略時に
 * active UI pack の state を read/write する。
 *
 * value は JSON serializable な値を推奨する。runtime は unknown として保持し、
 * MCP 経由では JSON として read/write される。
 */
export interface UiStateAPI {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  subscribe(key: string, listener: (value: unknown) => void): Disposable;
}

export interface UiLayoutAPI {
  /**
   * layout を full-replace する（reset → apply）。差分適用ではない：
   * 引数 `full` は「今適用したい layout の完全な形」であり、前回 apply した値は残らない。
   */
  update(full: UiLayout): void;
}

/**
 * ui.tsx の export default 型。
 *
 * mount は React 等で container を描画し、Disposable を返す。
 * dispose は pack deactivate 時（signal abort 直後）に呼ばれ、React root の
 * unmount / 子 Disposable の解放を行う責務を持つ。
 */
export interface UiPackDefinition {
  readonly id: string;
  readonly type: "ui";
  readonly layout: UiLayout;
  readonly mount: (ctx: UiContext, container: HTMLDivElement) => Disposable;
}
