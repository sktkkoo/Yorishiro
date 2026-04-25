/**
 * Terminal attention producer。
 *
 * PTY data 出力 / viewport scroll を listen し、`getViewportLineRects()` で
 * 全非空 line を取得して `classifyTerminalOutputAttentionReason()` で意味分類。
 * diagnostic / file-link に該当する line だけを別 source key で並列 emit する。
 * recent-output (意味なし) は emit しない (v2 原則「意味なきもの aura なし」)。
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
  readonly terminal: Pick<
    TerminalRuntime,
    "subscribePtyData" | "subscribeViewportScroll" | "getViewportLineRects"
  >;
}

export function startTerminalAttentionProducer(opts: StartOptions): Disposable {
  const { attention, terminal } = opts;
  const activeSources = new Set<string>();

  const scan = (): void => {
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

  const ptySub = terminal.subscribePtyData(scan);
  const scrollSub = terminal.subscribeViewportScroll(scan);

  return {
    dispose: () => {
      ptySub.dispose();
      scrollSub.dispose();
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
