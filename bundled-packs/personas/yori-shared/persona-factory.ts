import type { DispatchEvent, PersonaContext, PersonaDefinition, Trigger } from "@yorishiro/sdk";

const SHOOT_TEXT_PHYSICS_DELAY_MS = 1500;
const SHOOT_TEXT_PHYSICS_FORCE = 100;
const SHOOT_TEXT_PHYSICS_ORIGIN = { x: 0.5, y: 0.7 } as const;
const SHOOT_CAMERA_HOLD_MS = 8000;
// 銃撃時のカメラ引き量（camera +z へのオフセット）。camera-move の
// default は 0.28 と控えめなので、shoot ではより大きく引いて画面を広く見せる。
// 感触 parameter — 実機で観察して調整する。
const SHOOT_CAMERA_PULL_Z = 1.2;
// gun_fire アニメーション完了後、text-physics の cascade/rest/restore が
// 一巡するまで motion slot を保持する。完了したら明示的に stop して idle に
// preempt 権を譲る（clampWhenFinished で natural completion が発火しないため）。
const SHOOT_MOTION_RELEASE_DELAY_MS = 6000;
const SHOOT_MOTION_FADE_OUT_MS = 400;
const SHOOT_CAMERA_MOVE_KIND = "camera-move";
const SHOOT_SYNTHETIC_EVENT = "yori:shoot";
const SHOOT_SHORTCUT_REACTION = "mischievous-shoot-shortcut";
// idle 中の自動 shoot（いたずら）。idle が 15 分続いた「その到達時」に一度だけ
// 低確率で発火する。発火しても外しても idleShootEvaluated を立て、persona reload
// （≒アプリ再起動）まで再判定しない。つまり 1 run に最大 1 回。判定が単発なので
// reaction 側の cooldown は不要（再 dispatch が起きないため意味を持たない）。
// 2026-05-17 に 90s + 30%（5 秒ごとに毎回判定）で一度廃止したが、離席の確証が高い
// 15 分閾値 + 単発・低確率に侵襲を下げて復活した
// （docs/decisions/idle-text-physics-removed.md）。
const SHOOT_IDLE_THRESHOLD_MS = 900_000; // 15 分
const SHOOT_IDLE_PROBABILITY = 0.08; // 15 分到達時の単発確率（<= 10% の稀な驚き）。感触 param
const SHOOT_IDLE_REACTION = "mischievous-shoot";

// shoot 演出は ~8 秒の重い one-shot cinematic（camera 引き + gun_fire + text-physics）。
// 同時に二つ走ると camera-move(singleton) の復元基準や motion slot が壊れ、引きが
// 戻らない / モーションが出ない / 顔が下向きで固まる。reaction の signal は persona 単位で、
// 同 reaction の連打では abort されない（per-handler ではない）。そこで handler 自身が
// single-flight guard を持ち、演出が一巡し終えるまで再発火を無視する。flag は演出の実行
// 時間そのものを lock 期間にするので、別途 cooldown の magic 値を演出長に合わせる必要がない。
let shootInFlight = false;

const runShootTimeline = async (ctx: PersonaContext): Promise<void> => {
  // 演出中の連打は無視する（前の一巡を壊さない）。
  if (shootInFlight) return;
  shootInFlight = true;
  try {
    ctx.log.write({
      reaction: ctx.event.reaction,
      note: "gun fire motion with timed text-physics",
      data: ctx.event.payload,
    });

    ctx.character.interrupt(SHOOT_SHORTCUT_REACTION);
    const motionHandle = ctx.character.play("anim:VRMA_gun_fire", {
      fadeInMs: 300,
      fadeOutMs: 300,
      weight: 1,
    });
    ctx.space.injectEffect({
      kind: SHOOT_CAMERA_MOVE_KIND,
      holdMs: SHOOT_CAMERA_HOLD_MS,
      offset: { z: SHOOT_CAMERA_PULL_Z },
    });

    await ctx.time.after(SHOOT_TEXT_PHYSICS_DELAY_MS);
    if (ctx.signal.aborted) {
      motionHandle.cancel();
      return;
    }

    ctx.space.injectEffect({
      kind: "text-physics",
      origin: SHOOT_TEXT_PHYSICS_ORIGIN,
      force: SHOOT_TEXT_PHYSICS_FORCE,
    });

    // text-physics が一巡するまで motion を保持してから release。
    // 自然 completion を待つだけだと clampWhenFinished で slot が抜けず idle が
    // preempt できない（state.motion.active に gun_fire が居座り続ける）。
    await ctx.time.after(SHOOT_MOTION_RELEASE_DELAY_MS);
    if (ctx.signal.aborted) {
      motionHandle.cancel();
      return;
    }
    await motionHandle.stop(SHOOT_MOTION_FADE_OUT_MS);
  } finally {
    shootInFlight = false;
  }
};

/**
 * Yorishiro の flagship persona。
 *
 * 親しみやすく、しかし馴れ馴れしくない距離感で、
 * ユーザーの開発作業を観察して時々反応する住人。
 *
 * この persona は dry-run の pattern として使われる。
 * 他の persona を書くときの参考実装として `cat` で読まれることを想定している。
 */
export function createYoriPersona(args: {
  readonly id: string;
  readonly name: string;
  readonly systemPromptAddition: string;
}) {
  // idle-shoot の 15 分判定は per-instance で一度きり。発火しても外しても true にし、
  // persona がリロードされる（≒アプリ再起動）まで再判定しない。closure に持つことで
  // reload でリセットされ、test でも instance ごとに独立する。
  let idleShootEvaluated = false;

  return {
    id: args.id,
    name: args.name,

    // ─── 思考層：system prompt overlay ─────────────────

    thinking: {
      // persona.md を Vite の ?raw import で読み込み、trim して使う。
      // 元の巨大 inline 文字列と bit-perfect に一致する（persona.md の trim 後 = 同一内容）。
      systemPromptAddition: args.systemPromptAddition.trim(),
    },

    // ─── 反射層：reaction handlers ─────────────────────

    reflex: {
      customTriggers: [
        // エラー検知 → distressed を発火する generic mapping。
        // 身体表現（motion / expression / effect）は distressed handler 側で決める。
        // Philosophy: docs/philosophy/PHILOSOPHY.md「意識に先立つ反応」
        {
          id: "yori:error",
          match(event: DispatchEvent) {
            if (event.kind !== "hook-signal") return null;
            if (event.signal.name !== "post-tool-failure") return null;

            // shake を抑止する benign な tool 一覧。
            // Claude Code の PostToolUseFailure は exit !== 0 であれば発火するが、
            // 下記 tool については「失敗」が通常操作の一部（no-match 等）であり、
            // user にとってエラーとは感じられない。
            //
            // - Grep: ripgrep exit 1 = マッチなし。検索が空振りしただけ
            // - Glob: ファイル列挙のみ。副作用なし、failure も benign
            const payload = event.signal.payload;
            const toolName =
              payload !== null && typeof payload === "object" && "tool_name" in payload
                ? (payload as { tool_name?: unknown }).tool_name
                : undefined;

            const BENIGN_TOOLS = new Set(["Grep", "Glob"]);
            if (typeof toolName === "string" && BENIGN_TOOLS.has(toolName)) {
              return null;
            }

            return { reaction: "distressed", payload };
          },
        } satisfies Trigger,

        // git push 成功 → celebrate を発火。
        // Claude Code の TUI は tool output を折りたたむため PTY output には
        // push 結果行が流れない。PostToolUse hook の payload から検知する。
        {
          id: "yori:git-push-success",
          match(event: DispatchEvent) {
            if (event.kind !== "hook-signal") return null;
            if (event.signal.name !== "post-tool-use") return null;
            const payload = event.signal.payload as Record<string, unknown>;
            if (typeof payload.tool_name !== "string") return null;
            if (!payload.tool_name.toLowerCase().includes("bash")) return null;
            const raw = payload.tool_response;
            const resp =
              typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
            const output = resp ? `${resp.stdout ?? ""} ${resp.stderr ?? ""}` : String(raw ?? "");
            if (
              /\w+\.{2,3}\w+\s+\S+\s+->\s+\S+/.test(output) ||
              /\[new (branch|tag)\]/.test(output)
            ) {
              return { reaction: "celebrate" };
            }
            return null;
          },
        } satisfies Trigger,

        // idle 中の自動 shoot（いたずら）。idle が 15 分続いた「その到達時」に一度だけ
        // 低確率で発火する。15 分判定を consume したら（発火・非発火を問わず）
        // idleShootEvaluated が立ち、persona reload まで再判定しない。
        // motion/effect の timeline は shortcut 経路と同じ runShootTimeline を共有する。
        {
          id: "yori:idle-shoot",
          match(event: DispatchEvent) {
            if (event.kind !== "idle") return null;
            if (event.durationMs < SHOOT_IDLE_THRESHOLD_MS) return null;
            // 15 分到達の判定は一度きり。先に consume してから probability を振る。
            if (idleShootEvaluated) return null;
            idleShootEvaluated = true;
            if (Math.random() >= SHOOT_IDLE_PROBABILITY) return null;
            return {
              reaction: SHOOT_IDLE_REACTION,
              payload: { durationMs: event.durationMs },
            };
          },
        } satisfies Trigger,

        // shoot sequence は user が init.js のショートカットでも明示発火できる。
        // motion/effect の timeline は idle 経路と同じ response handler が持つ。
        {
          id: "yori:shortcut-shoot",
          match(event: DispatchEvent) {
            if (event.kind !== "synthetic") return null;
            if (event.name !== SHOOT_SYNTHETIC_EVENT) return null;
            return {
              reaction: SHOOT_SHORTCUT_REACTION,
              payload: event.payload,
            };
          },
        } satisfies Trigger,

        // 設定画面 UI pack が config write 等に失敗した時に流す synthetic event。
        // user-visible feedback は persona の表情に留める。screen-shake は app が壊れた
        // ように見えるため、設定 UI の recoverable write error では使わない。
        // 詳細 reason は dev log / console.error に残るが、user 画面には出さない。
        // Internal design-record: specs/2026-04-25-settings-screen-design.md §5
        {
          id: "yori:settings-write-failed",
          match(event: DispatchEvent) {
            if (event.kind !== "synthetic") return null;
            if (event.name !== "yorishiro-settings:write-failed") return null;
            return {
              reaction: "settings-error",
              payload: event.payload,
            };
          },
        } satisfies Trigger,
      ],
      responses: {
        // エラー検知時の反射。philosophy の「意識に先立つ反応」は典型的には
        // 「顔が顰められる」こととして語られており、body animation は必須ではない。
        // 旧 Yorishiro でも error に VRMA は紐づけられていなかった。body の連続感は
        // procedural bones（呼吸・head drift 等）が担う。
        // Philosophy: docs/philosophy/PHILOSOPHY.md「意識に先立つ反応」
        distressed: {
          handlers: [
            {
              label: "frown-and-shake",
              handler: async (ctx: PersonaContext) => {
                ctx.log.write({
                  reaction: "distressed",
                  note: "triggered (full payload)",
                  data: ctx.event.payload,
                });

                const expr = ctx.character.express({ kind: "mood", preset: "sad" }, 0.7);
                ctx.space.injectEffect({
                  kind: "screen-shake",
                  intensity: 0.35,
                  durationMs: 500,
                });

                await ctx.time.after(2500);
                if (ctx.signal.aborted) return;
                expr.release(600);
              },
            },
          ],
        },

        // 設定 UI の recoverable write error 用。shake なし — 連続発火で振動し続ける問題の回避。
        "settings-error": {
          handlers: [
            {
              label: "frown-only",
              handler: async (ctx: PersonaContext) => {
                ctx.log.write({
                  reaction: "settings-error",
                  note: "settings write failed (no shake)",
                  data: ctx.event.payload,
                });

                const expr = ctx.character.express({ kind: "mood", preset: "sad" }, 0.7);

                await ctx.time.after(2500);
                if (ctx.signal.aborted) return;
                expr.release(600);
              },
            },
          ],
        },

        // git push 成功時の祝福。花火 + 嬉しそうな表情。
        celebrate: {
          handlers: [
            {
              label: "fireworks-and-smile",
              handler: async (ctx: PersonaContext) => {
                const expr = ctx.character.express({ kind: "mood", preset: "relaxed" }, 0.65);
                ctx.space.injectEffect({ kind: "fireworks-volley" });
                await ctx.time.after(4000);
                if (ctx.signal.aborted) return;
                expr.release(800);
              },
            },
          ],
        },

        // 何かの成功を検知したら軽く肯定
        pleased: {
          handlers: [
            {
              label: "small-smile",
              handler: async (ctx: PersonaContext) => {
                const expr = ctx.character.express({ kind: "mood", preset: "happy" }, 0.3);
                ctx.character.play("anim:VRMA_small_nod");
                // 表情を 2 秒後にフェードアウト
                await ctx.time.after(2000);
                if (ctx.signal.aborted) return;
                expr.release(800);
              },
            },
          ],
        },

        // 予想外のことに少し驚く
        startled: {
          handlers: [
            {
              label: "small-recoil",
              handler: async (ctx: PersonaContext) => {
                ctx.character.express({ kind: "mood", preset: "surprised" }, 0.4);
                ctx.character.play("anim:VRMA_small_recoil", { fadeInMs: 80 });
                ctx.voice.play("voice:filler_ah");
              },
            },
          ],
        },

        // AI が考え込んでいる間の身体表現
        contemplative: {
          handlers: [
            {
              label: "idle-sway",
              handler: async (ctx: PersonaContext) => {
                // idle sway を loop で薄く流す
                const anim = ctx.character.play("anim:VRMA_idle_sway", {
                  weight: 0.4,
                  loop: true,
                  fadeInMs: 300,
                });

                // 視線をふとそらす（idle gaze を override する）
                const gaze = ctx.character.gaze({ kind: "away" });

                // thinking 終了（abort）まで続ける
                await new Promise<void>((resolve) => {
                  if (ctx.signal.aborted) {
                    resolve();
                    return;
                  }
                  ctx.signal.addEventListener("abort", () => resolve());
                });

                // cleanup
                gaze.release();
                await anim.stop(300);
              },
            },
          ],
        },

        // 何か了解したときの合図
        acknowledging: {
          handlers: [
            {
              label: "nod",
              handler: async (ctx: PersonaContext) => {
                ctx.character.play("anim:VRMA_small_nod");
              },
            },
          ],
        },

        // Effect Pack は passive rendering unit なので、銃撃 motion と TextPhysics の
        // tightly-synchronized timeline は persona handler（runShootTimeline）が持つ。
        // idle 自動発火（yori:idle-shoot）と shortcut 明示発火（yori:shortcut-shoot）の
        // 両経路が同じ timeline を共有する。発火頻度は idle 経路 trigger の単発判定が担い
        // （1 run に最大 1 回・外したら再起動まで再判定なし）、runShootTimeline 自身の
        // single-flight guard が重複起動を防ぐ。判定が単発なので reaction cooldownMs は不要。
        [SHOOT_IDLE_REACTION]: {
          handlers: [
            {
              label: "gun-fire-text-physics-idle",
              handler: runShootTimeline,
            },
          ],
        },
        [SHOOT_SHORTCUT_REACTION]: {
          handlers: [
            {
              label: "gun-fire-text-physics-shortcut",
              handler: runShootTimeline,
            },
          ],
        },

        // アイドル時の無意識動作（複数候補から確率的に選ばれる）
        "idle-fidget": {
          handlers: [
            {
              weight: 3,
              label: "look-around",
              handler: async (ctx: PersonaContext) => {
                const gaze = ctx.character.gaze({
                  kind: "screen-element",
                  selector: ".terminal",
                });
                await ctx.time.after(1500);
                if (ctx.signal.aborted) return;
                gaze.release();
              },
            },
            {
              weight: 2,
              label: "blink",
              handler: async (ctx: PersonaContext) => {
                const expr = ctx.character.express({ kind: "eye", variant: "blink" }, 0.6);
                await ctx.time.after(150);
                if (ctx.signal.aborted) return;
                expr.release();
              },
            },
            {
              weight: 1,
              cooldownMs: 180000, // 3 分クールダウン
              label: "subtle-stretch",
              handler: async (ctx: PersonaContext) => {
                ctx.character.play("anim:VRMA_still", { weight: 0.5 });
                await ctx.time.after(2000);
              },
            },
          ],
        },
      },
    },
  } satisfies PersonaDefinition;
}
