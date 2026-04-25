import type { DispatchEvent, PersonaContext, PersonaDefinition, Trigger } from "@charminal/sdk";
import systemPromptAddition from "./persona.md?raw";

const SHOOT_IDLE_THRESHOLD_MS = 90_000;
const SHOOT_IDLE_PROBABILITY = 0.3;
const SHOOT_TEXT_PHYSICS_DELAY_MS = 1500;
const SHOOT_TEXT_PHYSICS_FORCE = 100;
const SHOOT_TEXT_PHYSICS_ORIGIN = { x: 0.5, y: 0.7 } as const;
const SHOOT_CAMERA_HOLD_MS = 8000;
const SHOOT_CAMERA_MOVE_KIND = "camera-move";
const SHOOT_SYNTHETIC_EVENT = "charminal-default:shoot";
const SHOOT_REACTION = "mischievous-shoot";
const SHOOT_SHORTCUT_REACTION = "mischievous-shoot-shortcut";

const runShootTimeline = async (ctx: PersonaContext): Promise<void> => {
  ctx.log.write({
    reaction: ctx.event.reaction,
    note: "gun fire motion with timed text-physics",
    data: ctx.event.payload,
  });

  ctx.character.interrupt(SHOOT_REACTION);
  ctx.character.play("anim:VRMA_gun_fire", {
    fadeInMs: 300,
    fadeOutMs: 300,
    weight: 1,
    priority: 10,
  });
  ctx.space.injectEffect({ kind: SHOOT_CAMERA_MOVE_KIND, holdMs: SHOOT_CAMERA_HOLD_MS });

  await ctx.time.after(SHOOT_TEXT_PHYSICS_DELAY_MS);
  if (ctx.signal.aborted) return;

  ctx.space.injectEffect({
    kind: "text-physics",
    origin: SHOOT_TEXT_PHYSICS_ORIGIN,
    force: SHOOT_TEXT_PHYSICS_FORCE,
  });
};

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
    // persona.md を Vite の ?raw import で読み込み、trim して使う。
    // 元の巨大 inline 文字列と bit-perfect に一致する（persona.md の trim 後 = 同一内容）。
    systemPromptAddition: systemPromptAddition.trim(),
  },

  // ─── 反射層：reaction handlers ─────────────────────

  reflex: {
    customTriggers: [
      // エラー検知 → distressed を発火する generic mapping。
      // 身体表現（motion / expression / effect）は distressed handler 側で決める。
      // Philosophy: docs/philosophy/CHARMINAL.md「意識に先立つ反応」
      {
        id: "charminal-default:error",
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

      // git push 成功 → celebrate を発火。PTY output から push 成功を示す
      // パターン（ブランチ更新 / 新規ブランチ / 新規タグ）を検知する。
      {
        id: "charminal-default:git-push-success",
        match(event: DispatchEvent) {
          if (event.kind !== "pty-output") return null;
          // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape strip に ESC 制御文字が必要
          const plain = event.text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          if (/\w+\.{2,3}\w+\s+\S+\s+->\s+\S+/.test(plain) || /\[new (branch|tag)\]/.test(plain)) {
            return { reaction: "celebrate" };
          }
          return null;
        },
      } satisfies Trigger,

      // 旧 Charminal の shoot sequence 相当：
      // idle が長く続いた時だけ、低確率で mischievous-shoot を発火する。
      // 実際の motion/effect 同期は response handler 側で 1 つの timeline として扱う。
      {
        id: "charminal-default:idle-shoot",
        match(event: DispatchEvent) {
          if (event.kind !== "idle") return null;
          if (event.durationMs < SHOOT_IDLE_THRESHOLD_MS) return null;
          if (Math.random() >= SHOOT_IDLE_PROBABILITY) return null;
          return {
            reaction: "mischievous-shoot",
            payload: { durationMs: event.durationMs },
          };
        },
      } satisfies Trigger,

      // User shortcuts can announce an explicit shoot request through init.js.
      // The motion/effect timeline still lives in the response handler below.
      {
        id: "charminal-default:shortcut-shoot",
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
      // user-visible feedback の主役は persona の distressed reaction（顔を顰める + screen-shake）。
      // 詳細 reason は dev log / console.error に残るが、user 画面には出さない。
      // Internal design-record: specs/2026-04-25-settings-screen-design.md §5
      {
        id: "charminal-default:settings-write-failed",
        match(event: DispatchEvent) {
          if (event.kind !== "synthetic") return null;
          if (event.name !== "charminal-settings:write-failed") return null;
          return {
            reaction: "distressed",
            payload: event.payload,
          };
        },
      } satisfies Trigger,
    ],
    responses: {
      // エラー検知時の反射。philosophy の「意識に先立つ反応」は典型的には
      // 「顔が顰められる」こととして語られており、body animation は必須ではない。
      // 旧 Charminal でも error に VRMA は紐づけられていなかった。body の連続感は
      // procedural bones（呼吸・head drift 等）が担う。
      // Philosophy: docs/philosophy/CHARMINAL.md「意識に先立つ反応」
      distressed: {
        handlers: [
          {
            label: "frown-and-shake",
            handler: async (ctx: PersonaContext) => {
              // 観察: どの tool / command がこの reaction を駆動したかを dev-log に残す。
              // user が「error じゃないのに shake」と感じたケースを特定するため。
              // ctx.event.payload は trigger の TriggerMatch.payload
              // （= PostToolUseFailure の生 payload）。
              ctx.log.write({
                reaction: "distressed",
                note: "triggered (full payload)",
                data: ctx.event.payload,
              });

              // 顔を顰める
              const expr = ctx.character.express({ kind: "mood", preset: "sad" }, 0.7);
              // 画面全体（ターミナル含む）が短く揺れる。
              // terminal の物理約束事を一瞬だけ破る — Charm 思想に近い強さ。
              // 軽い揺れ（"shake" = character 範囲のみ）は別 kind として用意してある。
              ctx.space.injectEffect({
                kind: "screen-shake",
                intensity: 0.35,
                durationMs: 500,
              });

              // 2.5 秒後にゆっくり戻す
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
              const expr = ctx.character.express({ kind: "mood", preset: "happy" }, 0.6);
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

      // Effect Pack は passive rendering unit
      // なので、銃撃 motion と TextPhysics の tightly-synchronized timeline は
      // persona handler が持つ。
      [SHOOT_REACTION]: {
        handlers: [
          {
            label: "gun-fire-text-physics",
            cooldownMs: 180000,
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
