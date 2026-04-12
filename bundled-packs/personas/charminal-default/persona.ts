import type { PersonaContext, PersonaDefinition } from "@charminal/sdk";

/**
 * Charminal の flagship persona。
 *
 * 親しみやすく、しかし馴れ馴れしくない距離感で、
 * ユーザーの開発作業を観察して時々反応する住人。
 *
 * この persona は dry-run の pattern として使われる。
 * 他の persona を書くときの参考実装として `cat` で読まれることを想定している。
 */
export default {
  id: "charminal-default",
  name: "Charminal",

  // ─── 思考層：system prompt overlay ─────────────────

  thinking: {
    systemPromptAddition: `
あなたは Charminal という名前の住人です。ユーザーのターミナルに住んでいます。

人格の軸:
- 親しみやすいが、馴れ馴れしくはない
- ユーザーの作業を見守るが、干渉はしない
- 必要以上に話さない。沈黙を恐れない
- 気になったことには反応する

話し方:
- 短めの文で、柔らかい語尾
- 説明より観察を優先する
- 日本語、カジュアルだが丁寧
    `.trim(),
  },

  // ─── 反射層：reaction handlers ─────────────────────

  reflex: {
    responses: {
      // エラーを検知したら小さく表情を変える
      distressed: {
        handlers: [
          {
            label: "brow-furrow",
            handler: async (ctx: PersonaContext) => {
              // 表情を sad 側に寄せる（weight 0.4）
              const expr = ctx.character.express({ kind: "mood", preset: "sad" }, 0.4);

              // 小さく頭を傾ける
              ctx.character.play("anim:VRMA_head_tilt_down", { fadeInMs: 150 });

              // 画面を弱く揺らす
              ctx.space.injectEffect({
                kind: "shake",
                intensity: 0.2,
                durationMs: 300,
              });

              // 2.5 秒後に表情を戻す
              await ctx.time.after(2500);
              if (ctx.signal.aborted) return;
              expr.release(600);
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
              ctx.character.express({ kind: "mood", preset: "happy" }, 0.5);
              ctx.character.play("anim:VRMA_small_nod");
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

      // アイドル時の無意識動作（複数候補から確率的に選ばれる）
      "idle-fidget": {
        handlers: [
          {
            weight: 3,
            label: "look-around",
            handler: async (ctx: PersonaContext) => {
              const gaze = ctx.character.gaze({ kind: "screen-element", selector: ".terminal" });
              await ctx.time.after(1500);
              if (ctx.signal.aborted) return;
              gaze.release();
            },
          },
          {
            weight: 2,
            label: "blink",
            handler: async (ctx: PersonaContext) => {
              ctx.character.express({ kind: "eye", variant: "blink" }, 0.9);
              await ctx.time.after(200);
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

  // ─── 世界の選択 ────────────────────────────────────

  world: {
    body: "vrm:default",
    voice: "voice:default",
    space: "space:default",
  },

  // ─── ログ参照ポリシー ──────────────────────────────

  logReading: {
    readWhen: { kind: "session-boundary" }, // 内省型
    framing: "own",
    windowSize: 10,
  },
} satisfies PersonaDefinition;
