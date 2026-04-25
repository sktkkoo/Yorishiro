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

  const scan = (): void => {
    const lines = terminal.getViewportLineRects();
    let diagnosticEmitted = false;
    let fileLinkEmitted = false;

    for (const line of lines) {
      const reason = classifyTerminalOutputAttentionReason(line.text);
      if (reason === "diagnostic" && !diagnosticEmitted) {
        emit(attention, "terminal:diagnostic", line, PRIORITY_DIAGNOSTIC, "diagnostic");
        diagnosticEmitted = true;
      } else if (reason === "file-link" && !fileLinkEmitted) {
        emit(attention, "terminal:file-link", line, PRIORITY_FILE_LINK, "file-link");
        fileLinkEmitted = true;
      }
      if (diagnosticEmitted && fileLinkEmitted) break;
    }

    if (!diagnosticEmitted) {
      attention.setSourceTarget("terminal:diagnostic", null);
    }
    if (!fileLinkEmitted) {
      attention.setSourceTarget("terminal:file-link", null);
    }
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
