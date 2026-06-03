/**
 * Music Shelf — Apple Music を操作する amenity pack。
 *
 * osascript 経由で Music.app をリモコン操作する。
 * 再生・一時停止・スキップ・プレイリスト選択・音量調整を MCP tool として公開し、
 * 曲の切り替わりを synthetic event で persona に通知する。
 *
 * user amenity pack の参考実装として読めるように書いてある。
 * 以下のパターンを示す：
 *   1. ctx.system.exec() による外部コマンド実行
 *   2. ctx.time.every() による定期 polling + 変化検知
 *   3. ctx.emitEvent() による persona への通知
 *   4. dispose での cleanup
 */

import type { AmenityContext, AmenityHandle, AmenityPackDefinition } from "@charminal/sdk";

// ─── osascript helper ───────────────────────────────────

/** Music.app に AppleScript を送って結果を返す。stdin 経由で渡すので shell injection しない。 */
async function tell(ctx: AmenityContext, script: string): Promise<string> {
  const fullScript = `tell application "Music"\n${script}\nend tell`;
  const { stdout, exitCode } = await ctx.system.exec("osascript", {
    input: fullScript,
  });
  if (exitCode !== 0) return "";
  return stdout.trim();
}

/** AppleScript 文字列リテラル用エスケープ。 */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─── 状態管理 ───────────────────────────────────────────

interface NowPlaying {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly state: string;
}

const EMPTY: NowPlaying = { title: "", artist: "", album: "", state: "stopped" };

/** 現在の再生情報を取得する。 */
async function fetchNowPlaying(ctx: AmenityContext): Promise<NowPlaying> {
  const state = await tell(ctx, "get player state as string");
  if (state !== "playing" && state !== "paused") {
    return { ...EMPTY, state };
  }
  const script = [
    'set t to name of current track & "\\n" & artist of current track & "\\n" & album of current track',
    "return t",
  ].join("\n");
  const raw = await tell(ctx, script);
  const [title = "", artist = "", album = ""] = raw.split("\n");
  return { title, artist, album, state };
}

// ─── activate ───────────────────────────────────────────

function createMusicShelf(ctx: AmenityContext): AmenityHandle {
  let last: NowPlaying = { ...EMPTY };
  let poller: { cancel(): void } | null = null;

  // polling は初回 tool 使用時に開始する。
  // 起動時から Music.app に触りに行かない（automation prompt 回避）。
  function ensurePolling(): void {
    if (poller !== null) return;
    poller = ctx.time.every(5000, () => {
      void (async () => {
        const now = await fetchNowPlaying(ctx);
        if (now.title !== last.title || now.artist !== last.artist) {
          if (now.title !== "") {
            ctx.emitEvent("music-shelf:track-changed", {
              title: now.title,
              artist: now.artist,
              album: now.album,
            });
          }
        }
        if (now.state !== last.state) {
          ctx.emitEvent("music-shelf:state-changed", { state: now.state });
        }
        last = now;
      })().catch(() => {});
    });
  }

  return {
    tools: {
      music_play: async (params) => {
        ensurePolling();
        const p = (params ?? {}) as { playlist?: string; shuffle?: boolean };
        if (p.shuffle) {
          await tell(ctx, "set shuffle enabled to true");
        }
        if (p.playlist) {
          await tell(ctx, `play playlist "${escapeAppleScript(p.playlist)}"`);
        } else {
          await tell(ctx, "play");
        }
        last = await fetchNowPlaying(ctx);
        ctx.emitEvent("music-shelf:state-changed", { state: "playing" });
        return { ok: true, nowPlaying: last };
      },

      music_pause: async () => {
        ensurePolling();
        await tell(ctx, "pause");
        last = { ...last, state: "paused" };
        ctx.emitEvent("music-shelf:state-changed", { state: "paused" });
        return { ok: true };
      },

      music_next: async () => {
        ensurePolling();
        await tell(ctx, "next track");
        // 少し待ってから曲情報を取得（切り替わりに若干のラグがある）
        await ctx.time.after(500);
        last = await fetchNowPlaying(ctx);
        ctx.emitEvent("music-shelf:track-changed", {
          title: last.title,
          artist: last.artist,
          album: last.album,
        });
        return { ok: true, nowPlaying: last };
      },

      music_previous: async () => {
        ensurePolling();
        await tell(ctx, "previous track");
        await ctx.time.after(500);
        last = await fetchNowPlaying(ctx);
        ctx.emitEvent("music-shelf:track-changed", {
          title: last.title,
          artist: last.artist,
          album: last.album,
        });
        return { ok: true, nowPlaying: last };
      },

      music_now_playing: async () => {
        last = await fetchNowPlaying(ctx);
        if (last.state !== "playing" && last.state !== "paused") {
          return { state: last.state };
        }
        const position = await tell(ctx, "get player position");
        const duration = await tell(ctx, "get duration of current track");
        return {
          ...last,
          positionSec: Number.parseFloat(position) || 0,
          durationSec: Number.parseFloat(duration) || 0,
        };
      },

      music_playlists: async () => {
        const raw = await tell(ctx, "get name of every playlist");
        const playlists = raw.split(", ").filter(Boolean);
        return { playlists };
      },

      music_volume: async (params) => {
        const p = (params ?? {}) as { level?: number };
        if (p.level !== undefined) {
          const clamped = Math.max(0, Math.min(100, Math.round(p.level)));
          await tell(ctx, `set sound volume to ${clamped}`);
          return { ok: true, volume: clamped };
        }
        const current = await tell(ctx, "get sound volume");
        return { volume: Number.parseInt(current, 10) || 0 };
      },
    },
    dispose: () => {
      poller?.cancel();
    },
  };
}

// ─── Pack Definition ────────────────────────────────────

export default {
  id: "music-shelf",
  name: "Music Shelf",
  toolMeta: [
    {
      name: "music_play",
      description: "Apple Music で再生を開始する",
      parameters: {
        playlist: { type: "string", description: "プレイリスト名（省略で現在の曲を再生）" },
        shuffle: { type: "boolean", description: "シャッフル再生にするか" },
      },
    },
    {
      name: "music_pause",
      description: "再生を一時停止する",
    },
    {
      name: "music_next",
      description: "次の曲にスキップする",
    },
    {
      name: "music_previous",
      description: "前の曲に戻る",
    },
    {
      name: "music_now_playing",
      description: "現在再生中の曲の情報を取得する（タイトル・アーティスト・アルバム・再生位置）",
    },
    {
      name: "music_playlists",
      description: "Apple Music のプレイリスト一覧を取得する",
    },
    {
      name: "music_volume",
      description: "音量を取得・設定する（0-100）",
      parameters: {
        level: { type: "number", description: "設定する音量（省略で現在値を返す）" },
      },
    },
  ],
  activate: async (ctx: AmenityContext) => createMusicShelf(ctx),
} satisfies AmenityPackDefinition;
