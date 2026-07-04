/**
 * Terminal attention producer。
 *
 * rAF aligned throttled loop で `getViewportLineRects()` を poll し、
 * bottom-most（配列先頭）から意味分類を行う。diagnostic / file-link に該当する行が
 * **新規に現れた** ときだけ emit し、`PULSE_MS` 後に null clear する一過性
 * （transient）設計。
 *
 * `getViewportLineRects()` は最終行から逆順で返すため、配列の index 0 が viewport
 * 最下行（= 直近出力行）となる。top-first ではなく bottom-first で scan することで
 * v1 の「直近出力行を優先」semantic に合わせる。
 *
 * ### 新規判定の仕組み
 * - 前 frame の diagnostic / file-link 行テキストを Set で保持する。
 * - 今 frame で新たに現れた行（= 前 frame の Set にない）を「新規」とし、
 *   カテゴリごとに最初の 1 行だけ emit する（bottom-first 順で直近行が優先）。
 * - emit 後 `setTimeout(PULSE_MS)` で null clear をスケジュールする。
 *   pulse 中に別の新規行が来た場合は既存 timer をキャンセルして上書きする。
 * - viewport が空になると seen Set がリセットされ、再表示時に再 emit が有効になる。
 *
 * ### A2+B2 設計変更
 * - diagnostic aura が常駐しなくなるため「typing が見える時間」が確保される。
 * - typing priority は input-cursor producer 側で 5 に変更（B2）。
 *   diagnostic priority 8 は維持（出現瞬間は強い、3 秒で消える）。
 *
 * event-driven (subscribePtyData / subscribeViewportScroll) は廃止。
 * PTY 出力後に xterm が行を確定する frame との乖離で diagnostic 検出が
 * 取りこぼされていたため、rAF に同期する。ただし可視行の全走査は重いので
 * 低頻度に間引く。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 *   「Producer 一覧と priority」section
 */

import { classifyTerminalOutputAttentionReason } from "../../core/attention";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { TerminalLineRect, TerminalRuntime } from "../terminal-runtime/types";
import type { Disposable } from "./types";

/** diagnostic / file-link pulse の持続時間（ms）。この時間後に source を null clear する */
const PULSE_MS = 3000;
export const TERMINAL_ATTENTION_SCAN_INTERVAL_MS = 100;

const PRIORITY_DIAGNOSTIC = 8;
const PRIORITY_FILE_LINK = 5;
// 意味分類は heuristic (regex ベース) のため確度は中程度。kind 内で
// priority 軸が支配的なため confidence は tie break 時のみ効く。
const CONFIDENCE = 0.7;

interface StartOptions {
  readonly attention: AttentionRuntime;
  readonly terminal: Pick<TerminalRuntime, "getViewportLineRects">;
  /**
   * テスト用 setTimeout 注入。省略時は globalThis.setTimeout。
   * timer ID の型は環境（Node / ブラウザ）で異なるため unknown で受け渡す。
   */
  readonly setTimeout?: (fn: () => void, delay: number) => unknown;
  /**
   * テスト用 clearTimeout 注入。省略時は globalThis.clearTimeout。
   */
  readonly clearTimeout?: (id: unknown) => void;
}

export function startTerminalAttentionProducer(opts: StartOptions): Disposable {
  const { attention, terminal } = opts;
  // DI 注入口。省略時は globalThis の関数にフォールバックする。
  // timer ID の型は環境（Node / ブラウザ）で異なるため、ここでは unknown で統一する。
  const setTimeoutFn: (fn: () => void, delay: number) => unknown =
    opts.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn: (id: unknown) => void =
    opts.clearTimeout ?? (globalThis.clearTimeout.bind(globalThis) as (id: unknown) => void);

  // 前 frame で検出済みの行テキストを保持する。
  // viewport が空になると次の tick で両 Set が clear され、再表示時に再 emit される。
  let seenDiagnosticLines = new Set<string>();
  let seenFileLinkLines = new Set<string>();
  let currentDiagnosticLines = new Set<string>();
  let currentFileLinkLines = new Set<string>();

  // source ごとの pending pulse timer を管理する。
  // 新規行が来たら既存 timer をキャンセルして上書きする（stacking しない）。
  const pulseTimers = new Map<string, unknown>();

  let rafId: number | null = null;
  let lastScanAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  /** source の pulse timer を開始（または上書き）し、PULSE_MS 後に null clear する */
  const startPulse = (source: string): void => {
    const existing = pulseTimers.get(source);
    if (existing !== undefined) clearTimeoutFn(existing);
    const timer = setTimeoutFn(() => {
      attention.setSourceTarget(source, null);
      pulseTimers.delete(source);
    }, PULSE_MS);
    pulseTimers.set(source, timer);
  };

  const scan = (): void => {
    // getViewportLineRects は最終行から逆順で返す（index 0 = 最下行 = 直近出力行）。
    // bottom-first で scan し、カテゴリごとに新規行の最初の 1 行だけ emit する。
    const lines = terminal.getViewportLineRects();

    // 今 frame に存在する行テキスト（次 frame の seen Set になる）。
    // Set は scan ごとに作らず swap して再利用する。
    currentDiagnosticLines.clear();
    currentFileLinkLines.clear();

    // emit 済みフラグ（1 frame 内の重複 emit 防止）
    let diagnosticEmitted = false;
    let fileLinkEmitted = false;

    for (const line of lines) {
      const reason = classifyTerminalOutputAttentionReason(line.text);

      if (reason === "diagnostic") {
        currentDiagnosticLines.add(line.text);
        if (!diagnosticEmitted && !seenDiagnosticLines.has(line.text)) {
          // 新規行が検出された：emit + pulse 開始
          emitLine(attention, "terminal:diagnostic", line, PRIORITY_DIAGNOSTIC, "diagnostic");
          startPulse("terminal:diagnostic");
          diagnosticEmitted = true;
        }
      } else if (reason === "file-link") {
        currentFileLinkLines.add(line.text);
        if (!fileLinkEmitted && !seenFileLinkLines.has(line.text)) {
          emitLine(attention, "terminal:file-link", line, PRIORITY_FILE_LINK, "file-link");
          startPulse("terminal:file-link");
          fileLinkEmitted = true;
        }
      }

      // 両カテゴリの新規行を発見済みなら早期終了
      if (diagnosticEmitted && fileLinkEmitted) break;
    }

    // seen Set を今 frame の内容で更新（viewport 空なら両 Set も空になる）
    const previousDiagnosticLines = seenDiagnosticLines;
    seenDiagnosticLines = currentDiagnosticLines;
    currentDiagnosticLines = previousDiagnosticLines;

    const previousFileLinkLines = seenFileLinkLines;
    seenFileLinkLines = currentFileLinkLines;
    currentFileLinkLines = previousFileLinkLines;
  };

  const tick = (now: DOMHighResTimeStamp): void => {
    if (disposed) return;
    if (now - lastScanAt >= TERMINAL_ATTENTION_SCAN_INTERVAL_MS) {
      lastScanAt = now;
      scan();
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return {
    dispose: () => {
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      // dispose 時に全 pulse timer をキャンセルし、active source を clear する
      for (const [source, timer] of pulseTimers) {
        clearTimeoutFn(timer);
        attention.setSourceTarget(source, null);
      }
      pulseTimers.clear();
    },
  };
}

function emitLine(
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
