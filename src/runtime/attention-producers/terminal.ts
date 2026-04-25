/**
 * Terminal attention producer。
 *
 * rAF loop で毎 frame `getViewportLineRects()` を poll し、bottom-most（配列先頭）
 * から意味分類を行う。diagnostic / file-link に該当する最初の行だけを各 source key
 * で emit する。recent-output は emit しない（v2 原則「意味なきもの aura なし」、
 * docs/decisions/semantic-priority-attention.md）。
 *
 * `getViewportLineRects()` は最終行から逆順で返すため、配列の index 0 が viewport
 * 最下行（= 直近出力行）となる。top-first ではなく bottom-first で scan することで
 * v1 の「直近出力行を優先」semantic に合わせる。
 *
 * event-driven (subscribePtyData / subscribeViewportScroll) は廃止。
 * PTY 出力後に xterm が行を確定する frame との乖離で diagnostic 検出が
 * 取りこぼされていたため、rAF loop に切り替えた。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 *   「Producer 一覧と priority」section
 */

import { classifyTerminalOutputAttentionReason } from "../../core/attention";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalLineRect, TerminalRuntime } from "../terminal-runtime/types";
import type { Disposable } from "./types";

const PRIORITY_DIAGNOSTIC = 8;
const PRIORITY_FILE_LINK = 5;
// 意味分類は heuristic (regex ベース) のため確度は中程度。kind 内で
// priority 軸が支配的なため confidence は tie break 時のみ効く。
const CONFIDENCE = 0.7;

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly terminal: Pick<TerminalRuntime, "getViewportLineRects">;
}

export function startTerminalAttentionProducer(opts: StartOptions): Disposable {
  const { attention, terminal } = opts;
  const activeSources = new Set<string>();
  let rafId: number | null = null;

  const scan = (): void => {
    // getViewportLineRects は最終行から逆順で返す（index 0 = 最下行 = 直近出力行）。
    // bottom-first で scan し、最初にマッチした行を各カテゴリの代表として emit する。
    const lines = terminal.getViewportLineRects();
    const nowActive = new Set<string>();

    for (const line of lines) {
      const reason = classifyTerminalOutputAttentionReason(line.text);
      if (reason === "diagnostic" && !nowActive.has("terminal:diagnostic")) {
        emit(attention, "terminal:diagnostic", line, PRIORITY_DIAGNOSTIC, "diagnostic");
        nowActive.add("terminal:diagnostic");
      } else if (reason === "file-link" && !nowActive.has("terminal:file-link")) {
        emit(attention, "terminal:file-link", line, PRIORITY_FILE_LINK, "file-link");
        nowActive.add("terminal:file-link");
      }
      if (nowActive.size === 2) break;
    }

    // 前回 active だが今回 emit しなかった source は null で clear
    for (const source of activeSources) {
      if (!nowActive.has(source)) {
        attention.setSourceTarget(source, null);
      }
    }

    activeSources.clear();
    for (const source of nowActive) activeSources.add(source);
  };

  const tick = (): void => {
    scan();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return {
    dispose: () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      // dispose 時に active source を全 clear する
      for (const source of activeSources) {
        attention.setSourceTarget(source, null);
      }
      activeSources.clear();
    },
  };
}

function emit(
  attention: AttentionRuntime,
  source: string,
  line: TerminalLineRect,
  priority: number,
  reason: string,
): void {
  attention.setSourceTarget(source, {
    kind: "terminal-region",
    source,
    rect: line.rect,
    confidence: CONFIDENCE,
    priority,
    timestamp: performance.now(),
    reason,
  });
}
