/**
 * text-physics — ターミナル文字の重力落下 + 復元 bundled Effect Pack。
 *
 * `ctx.renderer.queryTerminalCells()` で visible cells を取得し、
 * `ctx.renderer.addDomLayer()` で overlay div を確保。affected 行の文字を
 * `<span>` として overlay 上に複製し、4 phase の物理アニメーションを実行する：
 *
 * 1. **hold** (200ms): 文字を元位置に静止表示（overlay が xterm 上に被さる）
 * 2. **cascade**: V 字パターンの遅延で各文字が activate → 重力落下 + 回転 + バウンド
 * 3. **rest** (1000ms): 底面で静止
 * 4. **restore** (600ms): ease-out cubic で元位置に吸い込まれて復元
 *
 * ## カスケード遅延（V 字パターン）
 *
 * 下の行ほど早く落下し、中央から遠い文字ほど遅く落ちる。
 * `delay = (maxRow - row) * 40ms + distFromCenter * 15ms`
 *
 * ## 肌触り parameter（帰納的に調整する領域）
 *
 * GRAVITY / RESTITUTION / FRICTION / HOLD_MS / REST_MS / RESTORE_MS /
 * CASCADE_ROW_DELAY_MS / CASCADE_SPREAD_DELAY_MS は spec に固定せず、
 * 観察 → 微調整の loop で固める（CLAUDE.md「感触 parameter は帰納的に」）。
 */

import type { EffectContext, EffectDefinition, Vec2 } from "@charminal/sdk";

interface TextPhysicsOptions {
  readonly origin: Vec2;
  readonly force: number;
  readonly gravity?: number;
}

/** 物理演算中の各文字の状態 */
interface PhysicsChar {
  /** overlay 内 local 座標（元位置） */
  origX: number;
  origY: number;
  /** 現在位置 */
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  angularVelocity: number;
  char: string;
  color: string;
  fontSize: number;
  /** cascade phase で activate されるまでの遅延（ms） */
  cascadeDelay: number;
  activated: boolean;
  /** restore phase 開始時の位置・回転を記録 */
  restoreStartX: number;
  restoreStartY: number;
  restoreStartRotation: number;
  /** この文字に対応する DOM span */
  span: HTMLSpanElement;
}

type Phase = "hold" | "cascade" | "rest" | "restore" | "done";

/** 肌触り parameter の既定値。実装中の観察で微調整可能。 */
const GRAVITY = 600;
const ANGULAR_VEL_MIN = -3;
const ANGULAR_VEL_MAX = 3;
const RESTITUTION = 0.3;
const FRICTION = 0.8;
const AFFECTED_ROWS = 10;
const HOLD_MS = 200;
const REST_MS = 1000;
const RESTORE_MS = 600;
/** cascade 遅延: 行ごとの基本遅延（下の行ほど早い） */
const CASCADE_ROW_DELAY_MS = 40;
/** cascade 遅延: 中央からの距離ごとの追加遅延 */
const CASCADE_SPREAD_DELAY_MS = 15;
/** cascade が一定時間で強制終了する上限（ms） */
const CASCADE_TIMEOUT_MS = 4000;
/** 初速の水平方向ランダム幅 */
const INITIAL_VX_RANGE = 20;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** ease-out cubic: 1 - (1-t)^3。restore phase の吸い込みに使う。 */
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

export default {
  id: "text-physics",
  type: "effect",
  singleton: true,
  run: async (
    ctx: EffectContext<TextPhysicsOptions>,
    options: TextPhysicsOptions,
  ): Promise<void> => {
    const cellData = ctx.renderer.queryTerminalCells();
    if (!cellData) return;

    const gravity = options.gravity ?? GRAVITY;

    // 常にターミナル下端から AFFECTED_ROWS 行を対象にする（旧実装と同じ）。
    // origin は将来的にカスケードの起点として使う余地を残すが、行選択には影響しない。
    const cutoffRow = Math.max(0, cellData.rows - AFFECTED_ROWS);
    const maxAffectedRow = cellData.rows - 1;
    const affectedCells = cellData.cells.filter(
      (c) => c.row >= cutoffRow && c.row <= maxAffectedRow,
    );

    if (affectedCells.length === 0) return;

    let rafId: number | null = null;

    const handle = ctx.renderer.addDomLayer((container) => {
      // container のスタイル設定
      container.style.pointerEvents = "none";
      container.style.position = "absolute";
      container.style.left = "0";
      container.style.top = "0";
      container.style.width = "100%";
      container.style.height = "100%";
      container.style.overflow = "hidden";

      // affected 領域の背景マスク（xterm の文字を隠す）
      const maskDiv = document.createElement("div");
      maskDiv.style.position = "absolute";
      maskDiv.style.left = `${cellData.terminalRect.left}px`;
      maskDiv.style.top = `${cellData.terminalRect.top + cutoffRow * cellData.cellHeight}px`;
      maskDiv.style.width = `${cellData.terminalRect.width}px`;
      maskDiv.style.height = `${(maxAffectedRow - cutoffRow + 1) * cellData.cellHeight}px`;
      maskDiv.style.backgroundColor = "var(--charminal-bg, #0f1923)";
      maskDiv.style.zIndex = "1";
      container.appendChild(maskDiv);

      const maxRow = maxAffectedRow;
      const centerCol = cellData.cols / 2;

      // container の高さ（バウンドの底面計算用）
      // container は画面全体を覆う想定
      const containerHeight = window.innerHeight;

      // 各文字の PhysicsChar を生成し、span を container に追加
      const physicsCells: PhysicsChar[] = affectedCells.map((cell) => {
        const rowFromBottom = maxRow - cell.row;
        const distFromCenter = Math.abs(cell.col - centerCol);
        const cascadeDelay =
          rowFromBottom * CASCADE_ROW_DELAY_MS + distFromCenter * CASCADE_SPREAD_DELAY_MS;

        const span = document.createElement("span");
        span.textContent = cell.char;
        span.style.position = "absolute";
        span.style.left = `${cellData.terminalRect.left + cell.x}px`;
        span.style.top = `${cellData.terminalRect.top + cell.y}px`;
        span.style.color = cell.fgColor;
        span.style.fontSize = `${cellData.cellHeight}px`;
        span.style.fontFamily = "monospace";
        span.style.lineHeight = "1";
        span.style.zIndex = "2";
        span.style.willChange = "transform";
        container.appendChild(span);

        return {
          origX: cellData.terminalRect.left + cell.x,
          origY: cellData.terminalRect.top + cell.y,
          x: cellData.terminalRect.left + cell.x,
          y: cellData.terminalRect.top + cell.y,
          vx: rand(-INITIAL_VX_RANGE, INITIAL_VX_RANGE) * (options.force / 100),
          vy: 0,
          rotation: 0,
          angularVelocity: rand(ANGULAR_VEL_MIN, ANGULAR_VEL_MAX),
          char: cell.char,
          color: cell.fgColor,
          fontSize: cellData.cellHeight,
          cascadeDelay,
          activated: false,
          restoreStartX: 0,
          restoreStartY: 0,
          restoreStartRotation: 0,
          span,
        };
      });

      let phase: Phase = "hold";
      let phaseTimer = 0;
      let cascadeElapsed = 0;
      let lastTime = performance.now();

      const tick = (): void => {
        if (ctx.signal.aborted) {
          rafId = null;
          return;
        }

        const now = performance.now();
        const dt = (now - lastTime) / 1000; // 秒に変換
        lastTime = now;

        switch (phase) {
          case "hold":
            phaseTimer += dt * 1000;
            if (phaseTimer >= HOLD_MS) {
              phase = "cascade";
              phaseTimer = 0;
              cascadeElapsed = 0;
            }
            break;

          case "cascade": {
            cascadeElapsed += dt * 1000;
            let allActivated = true;
            let allSettled = true;

            for (const pc of physicsCells) {
              if (!pc.activated) {
                if (cascadeElapsed >= pc.cascadeDelay) {
                  pc.activated = true;
                } else {
                  allActivated = false;
                  allSettled = false;
                  continue;
                }
              }

              // 物理演算
              pc.vy += gravity * dt;
              pc.x += pc.vx * dt;
              pc.y += pc.vy * dt;
              pc.rotation += pc.angularVelocity * dt;

              // 底面バウンド
              const bottomLimit = containerHeight - pc.fontSize;
              if (pc.y >= bottomLimit) {
                pc.y = bottomLimit;
                pc.vy = -Math.abs(pc.vy) * RESTITUTION;
                pc.vx *= FRICTION;
                pc.angularVelocity *= FRICTION;
              }

              // settled 判定
              if (Math.abs(pc.vy) > 1 || pc.y < bottomLimit - 1) {
                allSettled = false;
              }

              // transform 更新
              const dx = pc.x - pc.origX;
              const dy = pc.y - pc.origY;
              pc.span.style.transform = `translate(${dx}px, ${dy}px) rotate(${pc.rotation}rad)`;
            }

            if ((allActivated && allSettled) || cascadeElapsed > CASCADE_TIMEOUT_MS) {
              for (const pc of physicsCells) {
                pc.activated = true;
                pc.vx = 0;
                pc.vy = 0;
                pc.angularVelocity = 0;
              }
              phase = "rest";
              phaseTimer = 0;
            }
            break;
          }

          case "rest":
            phaseTimer += dt * 1000;
            if (phaseTimer >= REST_MS) {
              for (const pc of physicsCells) {
                pc.restoreStartX = pc.x;
                pc.restoreStartY = pc.y;
                pc.restoreStartRotation = pc.rotation;
              }
              phase = "restore";
              phaseTimer = 0;
            }
            break;

          case "restore": {
            phaseTimer += dt * 1000;
            const progress = Math.min(1, phaseTimer / RESTORE_MS);
            const eased = easeOutCubic(progress);

            for (const pc of physicsCells) {
              pc.x = pc.restoreStartX + (pc.origX - pc.restoreStartX) * eased;
              pc.y = pc.restoreStartY + (pc.origY - pc.restoreStartY) * eased;
              pc.rotation = pc.restoreStartRotation * (1 - eased);

              const dx = pc.x - pc.origX;
              const dy = pc.y - pc.origY;
              pc.span.style.transform = `translate(${dx}px, ${dy}px) rotate(${pc.rotation}rad)`;
            }

            if (progress >= 1) {
              phase = "done";
            }
            break;
          }

          case "done":
            rafId = null;
            return;
        }

        rafId = requestAnimationFrame(tick);
      };

      rafId = requestAnimationFrame(tick);
    });

    // signal abort 時に即座に RAF cancel + handle.dispose する。
    // singleton: true なので、同 id の新規 dispatch で前の signal が abort される。
    // handle.dispose() は冪等なので finally と二重呼びになっても安全。
    const cleanup = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      handle.dispose();
    };
    ctx.signal.addEventListener("abort", cleanup, { once: true });

    try {
      // 全 phase を合計した最大所要時間で待つ。
      // cascade は最大 CASCADE_TIMEOUT_MS で打ち切られるので、
      // それを上限に使う。
      const totalMs = HOLD_MS + CASCADE_TIMEOUT_MS + REST_MS + RESTORE_MS;
      await ctx.time.after(totalMs);
    } finally {
      ctx.signal.removeEventListener("abort", cleanup);
      cleanup();
    }
  },
} satisfies EffectDefinition<TextPhysicsOptions>;
