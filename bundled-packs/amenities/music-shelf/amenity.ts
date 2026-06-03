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
async function tell(
  ctx: AmenityContext,
  script: string,
  options?: { readonly quiet?: boolean },
): Promise<string> {
  const fullScript = `tell application "Music"\n${script}\nend tell`;
  const { stdout, exitCode } = await ctx.system.exec("osascript", {
    input: fullScript,
    quiet: options?.quiet,
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

interface MusicTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationSec: number;
  readonly dateAdded?: string;
}

const EMPTY: NowPlaying = { title: "", artist: "", album: "", state: "stopped" };
const TRACK_ROW_EXPR = [
  "(persistent ID of t as text)",
  "(name of t as text)",
  "(artist of t as text)",
  "(album of t as text)",
  "(duration of t as text)",
].join(" & tab & ");
const TRACK_ROW_WITH_DATE_EXPR = `${TRACK_ROW_EXPR} & tab & (date added of t as text)`;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function parseTrackRows(raw: string): MusicTrack[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", title = "", artist = "", album = "", duration = "", dateAdded] =
        line.split("\t");
      return {
        id,
        title,
        artist,
        album,
        durationSec: Number.parseFloat(duration) || 0,
        ...(dateAdded ? { dateAdded } : {}),
      };
    })
    .filter((track) => track.id !== "");
}

function searchAreaClause(area: unknown): string {
  if (
    area === "names" ||
    area === "artists" ||
    area === "albums" ||
    area === "composers" ||
    area === "displayed"
  ) {
    return ` only ${area}`;
  }
  return "";
}

async function searchTracks(
  ctx: AmenityContext,
  query: string,
  opts?: { readonly limit?: number; readonly area?: unknown; readonly quiet?: boolean },
): Promise<MusicTrack[]> {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  const limit = clampInteger(opts?.limit, 10, 1, 50);
  const script = [
    `set matches to search library playlist 1 for "${escapeAppleScript(trimmed)}"${searchAreaClause(opts?.area)}`,
    'set rowsText to ""',
    `set maxItems to ${limit}`,
    "if (count of matches) < maxItems then set maxItems to count of matches",
    "repeat with i from 1 to maxItems",
    "set t to item i of matches",
    `set rowsText to rowsText & ${TRACK_ROW_EXPR} & linefeed`,
    "end repeat",
    "return rowsText",
  ].join("\n");
  return parseTrackRows(await tell(ctx, script, { quiet: opts?.quiet }));
}

async function findTrackById(
  ctx: AmenityContext,
  id: string,
  quiet = false,
): Promise<MusicTrack | null> {
  const trimmed = id.trim();
  if (trimmed === "") return null;
  const script = [
    `set targetId to "${escapeAppleScript(trimmed)}"`,
    "set matches to (tracks of library playlist 1 whose persistent ID is targetId)",
    'if (count of matches) is 0 then return ""',
    "set t to item 1 of matches",
    `return ${TRACK_ROW_EXPR}`,
  ].join("\n");
  return parseTrackRows(await tell(ctx, script, { quiet }))[0] ?? null;
}

async function playTrackById(ctx: AmenityContext, id: string): Promise<MusicTrack | null> {
  const trimmed = id.trim();
  if (trimmed === "") return null;
  const script = [
    `set targetId to "${escapeAppleScript(trimmed)}"`,
    "set matches to (tracks of library playlist 1 whose persistent ID is targetId)",
    'if (count of matches) is 0 then return ""',
    "set t to item 1 of matches",
    "play t",
    "delay 0.2",
    `return ${TRACK_ROW_EXPR}`,
  ].join("\n");
  return parseTrackRows(await tell(ctx, script))[0] ?? null;
}

/** 現在の再生情報を取得する。 */
async function fetchNowPlaying(
  ctx: AmenityContext,
  options?: { readonly quiet?: boolean },
): Promise<NowPlaying> {
  const state = await tell(ctx, "get player state as string", options);
  if (state !== "playing" && state !== "paused") {
    return { ...EMPTY, state };
  }
  const script = [
    'set t to name of current track & "\\n" & artist of current track & "\\n" & album of current track',
    "return t",
  ].join("\n");
  const raw = await tell(ctx, script, options);
  const [title = "", artist = "", album = ""] = raw.split("\n");
  return { title, artist, album, state };
}

// ─── activate ───────────────────────────────────────────

function createMusicShelf(ctx: AmenityContext): AmenityHandle {
  let last: NowPlaying = { ...EMPTY };
  let poller: { cancel(): void } | null = null;
  let stopTimer: { cancel(): void } | null = null;
  let stopTimerUntil = 0;
  let queue: MusicTrack[] = [];
  let fadeToken: { cancelled: boolean } | null = null;

  function emitTrackChanged(track: Pick<NowPlaying, "title" | "artist" | "album">): void {
    ctx.emitEvent("music-shelf:track-changed", {
      title: track.title,
      artist: track.artist,
      album: track.album,
    });
  }

  async function playQueuedTrack(): Promise<MusicTrack | null> {
    const next = queue.shift();
    if (next === undefined) return null;
    const played = await playTrackById(ctx, next.id);
    if (played !== null) {
      last = { title: played.title, artist: played.artist, album: played.album, state: "playing" };
      emitTrackChanged(last);
      ctx.emitEvent("music-shelf:state-changed", { state: "playing" });
    }
    return played;
  }

  // polling は初回 tool 使用時に開始する。
  // 起動時から Music.app に触りに行かない（automation prompt 回避）。
  function ensurePolling(): void {
    if (poller !== null) return;
    poller = ctx.time.every(5000, () => {
      void (async () => {
        const now = await fetchNowPlaying(ctx, { quiet: true });
        if (now.title !== last.title || now.artist !== last.artist) {
          if (queue.length > 0 && last.state === "playing" && last.title !== "") {
            await playQueuedTrack();
            return;
          }
          if (now.title !== "") {
            emitTrackChanged(now);
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
        last = await fetchNowPlaying(ctx, { quiet: true });
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
        const queued = await playQueuedTrack();
        if (queued !== null) return { ok: true, nowPlaying: { ...last } };
        await tell(ctx, "next track");
        // 少し待ってから曲情報を取得（切り替わりに若干のラグがある）
        await ctx.time.after(500);
        last = await fetchNowPlaying(ctx, { quiet: true });
        emitTrackChanged(last);
        return { ok: true, nowPlaying: last };
      },

      music_previous: async () => {
        ensurePolling();
        await tell(ctx, "previous track");
        await ctx.time.after(500);
        last = await fetchNowPlaying(ctx, { quiet: true });
        emitTrackChanged(last);
        return { ok: true, nowPlaying: last };
      },

      music_now_playing: async () => {
        last = await fetchNowPlaying(ctx, { quiet: true });
        if (last.state !== "playing" && last.state !== "paused") {
          return { state: last.state };
        }
        const position = await tell(ctx, "get player position", { quiet: true });
        const duration = await tell(ctx, "get duration of current track", { quiet: true });
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

      music_search: async (params) => {
        const p = (params ?? {}) as { query?: string; limit?: number; area?: string };
        const tracks = await searchTracks(ctx, p.query ?? "", {
          limit: p.limit,
          area: p.area,
          quiet: true,
        });
        return { tracks };
      },

      music_search_play: async (params) => {
        ensurePolling();
        const p = (params ?? {}) as { query?: string; limit?: number; area?: string };
        const tracks = await searchTracks(ctx, p.query ?? "", {
          limit: p.limit ?? 5,
          area: p.area,
          quiet: true,
        });
        const first = tracks[0];
        if (first === undefined) return { ok: false, reason: "no matches", tracks };
        const played = await playTrackById(ctx, first.id);
        if (played === null) return { ok: false, reason: "track not found", tracks };
        last = {
          title: played.title,
          artist: played.artist,
          album: played.album,
          state: "playing",
        };
        emitTrackChanged(last);
        ctx.emitEvent("music-shelf:state-changed", { state: "playing" });
        return { ok: true, track: played, matches: tracks };
      },

      music_play_track: async (params) => {
        ensurePolling();
        const p = (params ?? {}) as { id?: string; trackId?: string; persistentId?: string };
        const id = p.id ?? p.trackId ?? p.persistentId ?? "";
        const played = await playTrackById(ctx, id);
        if (played === null) return { ok: false, reason: "track not found" };
        last = {
          title: played.title,
          artist: played.artist,
          album: played.album,
          state: "playing",
        };
        emitTrackChanged(last);
        ctx.emitEvent("music-shelf:state-changed", { state: "playing" });
        return { ok: true, track: played };
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

      music_fade_volume: async (params) => {
        const p = (params ?? {}) as { level?: number; durationMs?: number; durationSec?: number };
        const target = clampInteger(p.level, 50, 0, 100);
        const durationMs = clampInteger(
          p.durationMs ?? (p.durationSec ?? 3) * 1000,
          3000,
          0,
          60_000,
        );
        const current =
          Number.parseInt(await tell(ctx, "get sound volume", { quiet: true }), 10) || 0;
        fadeToken = { cancelled: false };
        const token = fadeToken;
        const steps = Math.max(1, Math.ceil(durationMs / 250));
        for (let step = 1; step <= steps; step++) {
          if (token.cancelled) return { ok: false, cancelled: true, volume: current };
          const level = Math.round(current + (target - current) * (step / steps));
          await tell(ctx, `set sound volume to ${level}`, { quiet: true });
          if (step < steps) await ctx.time.after(durationMs / steps);
        }
        if (fadeToken === token) fadeToken = null;
        return { ok: true, volume: target };
      },

      music_queue: async (params) => {
        const p = (params ?? {}) as {
          action?: "add" | "list" | "clear" | "remove";
          query?: string;
          id?: string;
          trackId?: string;
          persistentId?: string;
          index?: number;
        };
        const action = p.action ?? "list";
        if (action === "clear") {
          queue = [];
          return { ok: true, queue };
        }
        if (action === "remove") {
          const index = clampInteger(p.index, 1, 1, Math.max(1, queue.length)) - 1;
          const removed = queue.splice(index, 1);
          return { ok: true, removed: removed[0] ?? null, queue };
        }
        if (action === "add") {
          const id = p.id ?? p.trackId ?? p.persistentId;
          const track =
            id !== undefined
              ? await findTrackById(ctx, id, true)
              : ((await searchTracks(ctx, p.query ?? "", { limit: 1, quiet: true }))[0] ?? null);
          if (track === null) return { ok: false, reason: "track not found", queue };
          queue.push(track);
          return { ok: true, queued: track, queue };
        }
        return { ok: true, queue };
      },

      music_shuffle: async (params) => {
        const p = (params ?? {}) as { enabled?: boolean; mode?: "songs" | "albums" | "groupings" };
        const lines: string[] = [];
        if (typeof p.enabled === "boolean") {
          lines.push(`set shuffle enabled to ${p.enabled ? "true" : "false"}`);
        }
        if (p.mode === "songs" || p.mode === "albums" || p.mode === "groupings") {
          lines.push(`set shuffle mode to ${p.mode}`);
        }
        lines.push('return (shuffle enabled as text) & "\\n" & (shuffle mode as text)');
        const [enabled = "false", mode = "songs"] = (await tell(ctx, lines.join("\n"))).split("\n");
        return { enabled: enabled === "true", mode };
      },

      music_repeat: async (params) => {
        const p = (params ?? {}) as { mode?: "off" | "one" | "all" };
        const lines: string[] = [];
        if (p.mode === "off" || p.mode === "one" || p.mode === "all") {
          lines.push(`set song repeat to ${p.mode}`);
        }
        lines.push("return song repeat as text");
        return { mode: await tell(ctx, lines.join("\n")) };
      },

      music_library_summary: async (params) => {
        const p = (params ?? {}) as { sampleLimit?: number; artistLimit?: number };
        const sampleLimit = clampInteger(p.sampleLimit, 100, 1, 500);
        const artistLimit = clampInteger(p.artistLimit, 50, 1, 200);
        const script = [
          "set trackCount to count of tracks of library playlist 1",
          'set rowsText to ""',
          `set maxItems to ${sampleLimit}`,
          "if trackCount < maxItems then set maxItems to trackCount",
          "repeat with i from 1 to maxItems",
          "set t to track i of library playlist 1",
          `set rowsText to rowsText & ${TRACK_ROW_WITH_DATE_EXPR} & linefeed`,
          "end repeat",
          "return (trackCount as text) & linefeed & rowsText",
        ].join("\n");
        const [countLine = "0", ...rows] = (await tell(ctx, script, { quiet: true })).split(
          /\r?\n/,
        );
        const sampleTracks = parseTrackRows(rows.join("\n"));
        const artists = Array.from(
          new Set(sampleTracks.map((track) => track.artist).filter(Boolean)),
        ).slice(0, artistLimit);
        return {
          trackCount: Number.parseInt(countLine, 10) || 0,
          artists,
          sampleTracks: sampleTracks.slice(0, 20),
          recentlyAdded: sampleTracks.filter((track) => track.dateAdded !== undefined).slice(0, 10),
        };
      },

      music_stop_after: async (params) => {
        const p = (params ?? {}) as {
          seconds?: number;
          minutes?: number;
          mode?: "delay" | "trackEnd";
          action?: "pause" | "stop";
          cancel?: boolean;
        };
        if (p.cancel) {
          stopTimer?.cancel();
          stopTimer = null;
          stopTimerUntil = 0;
          return { ok: true, pending: null };
        }
        if (p.seconds === undefined && p.minutes === undefined && p.mode === undefined) {
          return {
            pending:
              stopTimer === null
                ? null
                : {
                    until: stopTimerUntil,
                    remainingMs: Math.max(0, stopTimerUntil - ctx.time.now()),
                  },
          };
        }

        let delayMs = clampInteger(
          (p.minutes ?? 0) * 60_000 + (p.seconds ?? 0) * 1000,
          0,
          0,
          86_400_000,
        );
        if (p.mode === "trackEnd") {
          const current = await (async () => {
            last = await fetchNowPlaying(ctx, { quiet: true });
            if (last.state !== "playing" && last.state !== "paused") return null;
            const position =
              Number.parseFloat(await tell(ctx, "get player position", { quiet: true })) || 0;
            const duration =
              Number.parseFloat(
                await tell(ctx, "get duration of current track", { quiet: true }),
              ) || 0;
            return { position, duration };
          })();
          if (current === null) return { ok: false, reason: "no active track" };
          delayMs = Math.max(0, Math.round((current.duration - current.position + 0.5) * 1000));
        }
        const action = p.action === "stop" ? "stop" : "pause";
        stopTimer?.cancel();
        stopTimerUntil = ctx.time.now() + delayMs;
        stopTimer = ctx.time.schedule(delayMs, () => {
          void tell(ctx, action).finally(() => {
            stopTimer = null;
            stopTimerUntil = 0;
          });
        });
        return { ok: true, action, delayMs, until: stopTimerUntil };
      },
    },
    dispose: () => {
      poller?.cancel();
      stopTimer?.cancel();
      fadeToken = { cancelled: true };
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
      name: "music_search",
      description: "曲名・アーティスト・アルバムを検索して候補を返す",
      parameters: {
        query: { type: "string", description: "検索語" },
        limit: { type: "number", description: "最大件数（1-50）" },
        area: { type: "string", description: "names / artists / albums / displayed / composers" },
      },
    },
    {
      name: "music_search_play",
      description: "検索語に一致する最初の曲を再生する",
      parameters: {
        query: { type: "string", description: "検索語" },
        limit: { type: "number", description: "候補として返す最大件数" },
      },
    },
    {
      name: "music_play_track",
      description: "検索結果の track id（persistent ID）を指定して再生する",
      parameters: {
        id: { type: "string", description: "music_search が返す track id" },
      },
    },
    {
      name: "music_volume",
      description: "音量を取得・設定する（0-100）",
      parameters: {
        level: { type: "number", description: "設定する音量（省略で現在値を返す）" },
      },
    },
    {
      name: "music_fade_volume",
      description: "指定時間をかけて音量を変更する",
      parameters: {
        level: { type: "number", description: "目標音量（0-100）" },
        durationMs: { type: "number", description: "フェード時間（ms）" },
      },
    },
    {
      name: "music_queue",
      description: "music-shelf 内部キューに曲を追加・表示・削除する",
      parameters: {
        action: { type: "string", description: "add / list / clear / remove" },
        query: { type: "string", description: "add 時の検索語" },
        id: { type: "string", description: "add 時の track id" },
        index: { type: "number", description: "remove 時の 1-based index" },
      },
    },
    {
      name: "music_shuffle",
      description: "シャッフル状態を取得・設定する",
      parameters: {
        enabled: { type: "boolean", description: "シャッフルを有効にするか" },
        mode: { type: "string", description: "songs / albums / groupings" },
      },
    },
    {
      name: "music_repeat",
      description: "リピート状態を取得・設定する",
      parameters: {
        mode: { type: "string", description: "off / one / all" },
      },
    },
    {
      name: "music_library_summary",
      description: "ライブラリの曲数・アーティスト・代表候補を返す",
      parameters: {
        sampleLimit: { type: "number", description: "集計対象にする先頭曲数" },
        artistLimit: { type: "number", description: "返すアーティスト数" },
      },
    },
    {
      name: "music_stop_after",
      description: "指定時間後、または現在の曲の終了付近で再生を止める",
      parameters: {
        seconds: { type: "number", description: "停止までの秒数" },
        minutes: { type: "number", description: "停止までの分数" },
        mode: { type: "string", description: "delay / trackEnd" },
        action: { type: "string", description: "pause / stop" },
        cancel: { type: "boolean", description: "予約をキャンセルする" },
      },
    },
  ],
  activate: async (ctx: AmenityContext) => createMusicShelf(ctx),
} satisfies AmenityPackDefinition;
