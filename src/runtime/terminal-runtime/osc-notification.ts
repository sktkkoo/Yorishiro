/**
 * OSC 9 / 99 / 777 通知シーケンスのパーサ（observation only）。
 *
 * cmux の "notification ring"（住人が入力待ちになると pane が光る）の正体は、
 * 特別な IPC ではなく terminal 出力に流れる notification 系 OSC を受動的に拾う
 * だけ。Charminal も同じ infra（xterm の registerOscHandler）で読み取れる。
 *
 *   - OSC 9  ; <body>                      iTerm2 / Codex(osc9) generic 単文字列
 *   - OSC 99 ; [metadata] ; <body>         kitty 系（metadata は任意）
 *   - OSC 777 ; notify ; <title> ; <body>  urxvt / tmux 系
 *
 * これは prompt marker 系（OSC 133 / 633）とは別 class の「通知」であり、
 * 「awaiting input / 完了通知」など agent の注意要求を表す。observation-only:
 * パーサは入力文字列を解釈するだけで、PTY へは一切書かない。
 */

/** notification 系 OSC の識別子。 */
export type OscNotificationCode = 9 | 99 | 777;

/** パース結果。body は必須、title は運べる format でのみ付く。 */
export interface TerminalNotification {
  readonly title: string | null;
  readonly body: string;
}

/**
 * registerOscHandler が渡す「`<code>;` を除いた data」をパースする。
 *
 * 例:
 *   parseOscNotification(9, "Agent waiting for input")
 *     → { title: null, body: "Agent waiting for input" }
 *   parseOscNotification(777, "notify;Claude;Permission needed")
 *     → { title: "Claude", body: "Permission needed" }
 *   parseOscNotification(99, "i=1:d=0;Build finished")
 *     → { title: null, body: "Build finished" }
 *
 * 空 body や未対応 sub-command は null（＝通知として扱わない）。
 */
export function parseOscNotification(
  code: OscNotificationCode,
  data: string,
): TerminalNotification | null {
  switch (code) {
    case 9:
      return finalize(null, data);
    case 99:
      return parseOsc99(data);
    case 777:
      return parseOsc777(data);
  }
}

/**
 * kitty 系 OSC 99。`metadata ; body` または `body` 単体。metadata は
 * `key=value` を含むので、先頭 segment が metadata らしければ body は残り。
 */
function parseOsc99(data: string): TerminalNotification | null {
  const sep = data.indexOf(";");
  if (sep === -1) return finalize(null, data);
  const head = data.slice(0, sep);
  const rest = data.slice(sep + 1);
  if (looksLikeMetadata(head)) return finalize(null, rest);
  // metadata でなければ全体を body 扱い（`;` を含む素朴な通知）。
  return finalize(null, data);
}

/**
 * urxvt / tmux 系 OSC 777。`notify ; <title> ; <body>`。
 * sub-command が notify 以外（例: precmd 等）の場合は通知として扱わない。
 */
function parseOsc777(data: string): TerminalNotification | null {
  const parts = data.split(";");
  if (parts[0] !== "notify") return null;
  const title = parts[1] ?? "";
  const body = parts.slice(2).join(";");
  // body が空で title だけのときは title を body に昇格する。
  if (body.trim().length === 0) return finalize(null, title);
  return finalize(title, body);
}

/** `key=value` を含む segment を metadata とみなす（kitty の i=.. d=.. 等）。 */
function looksLikeMetadata(segment: string): boolean {
  return /[a-zA-Z]=[^;]*/.test(segment);
}

function finalize(title: string | null, body: string): TerminalNotification | null {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) return null;
  const trimmedTitle = title?.trim() ?? "";
  return {
    title: trimmedTitle.length > 0 ? trimmedTitle : null,
    body: trimmedBody,
  };
}
