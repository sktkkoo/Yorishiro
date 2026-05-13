/**
 * @charminal/sdk/amenity
 *
 * Amenity Pack の定義型。
 * 住人の空間に備え付けられた機能設備（ポモドーロタイマー、天気確認、音楽再生など）を
 * pack として提供するための型。
 *
 * amenity.ts では `satisfies AmenityPackDefinition` を使って export default する。
 *
 * ⚠️ 重要：Amenity は motion-free。character / voice / space API は
 * AmenityContext に存在しない。キャラクターの反応が必要な場合は
 * `ctx.emitEvent()` で synthetic event を announce し、persona の
 * reflex trigger に拾わせる（twin-trigger co-emission）。
 */

import type { AmenityContext } from "./context";
import type { Disposable } from "./context";
import type { Trigger } from "./reaction";

// ─── AmenityHandle ───────────────────────────────────────

/** activate() が返す handle。tools と dispose を持つ。 */
export interface AmenityHandle {
  /** この amenity が提供する tool handler。key は tool 名。 */
  readonly tools: Readonly<Record<string, AmenityToolHandler>>;
  /** pack disable / アプリ終了時に呼ばれる後片付け。 */
  readonly dispose: () => void;
}

/** 個々の tool handler の signature。MCP 経由で呼ばれる。 */
export type AmenityToolHandler = (params: unknown) => Promise<unknown>;

// ─── AmenityToolMeta ─────────────────────────────────────

/** MCP tool listing 用の静的メタデータ。activate 前でも参照可能。 */
export interface AmenityToolMeta {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
}

// ─── AmenityPackDefinition ───────────────────────────────

/**
 * Amenity Pack の entry file が export default するオブジェクトの型。
 *
 * 例：
 * ```typescript
 * import type { AmenityPackDefinition, AmenityContext } from '@charminal/sdk';
 *
 * export default {
 *   id: 'pomodoro',
 *   name: 'Pomodoro Timer',
 *   toolMeta: [
 *     { name: 'pomodoro_start', description: 'Start a pomodoro session' },
 *     { name: 'pomodoro_stop', description: 'Stop the current session' },
 *     { name: 'pomodoro_status', description: 'Get current pomodoro status' },
 *   ],
 *   activate: async (ctx: AmenityContext) => {
 *     const timer = createTimer(ctx);
 *     return {
 *       tools: {
 *         pomodoro_start: async (params) => timer.start(params),
 *         pomodoro_stop: async () => timer.stop(),
 *         pomodoro_status: async () => timer.status(),
 *       },
 *       dispose: () => timer.dispose(),
 *     };
 *   },
 * } satisfies AmenityPackDefinition;
 * ```
 */
export interface AmenityPackDefinition {
  readonly id: string;
  readonly name: string;

  /**
   * MCP tool listing 用の静的メタデータ。
   * activate 前でも MCP client に tool 一覧を返せるようにするための宣言。
   * handle.tools の key と一致する contract。
   */
  readonly toolMeta?: ReadonlyArray<AmenityToolMeta>;

  /**
   * Pack enable 時に呼ばれる lifecycle 関数。
   * AmenityHandle を返し、handle.dispose() が disable 時に呼ばれる。
   *
   * ctx.signal は pack disable 時に abort される。activate 内で起動した
   * 非同期処理はこの signal を監視して cleanup すること。
   */
  readonly activate: (ctx: AmenityContext) => Promise<AmenityHandle>;

  /**
   * event bus に登録する custom trigger。
   * 環境 event を受けて独自の reaction type に変換する。
   */
  readonly customTriggers?: ReadonlyArray<Trigger>;
}

// ─── AmenityPackManifest ─────────────────────────────────

export interface AmenityPackManifest {
  readonly id: string;
  readonly name?: string;
  readonly type: "amenity";
  readonly version: string;
  readonly charminalVersion: string;
  readonly entry: string;
  readonly description?: string;
  readonly $schema?: string;
}
