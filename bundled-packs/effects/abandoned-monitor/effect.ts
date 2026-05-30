/**
 * abandoned-monitor — 放置された監視端末風 ARG overlay bundled Effect Pack。
 *
 * 旧 user pack `arg-text` の演出と option を 1:1 で TypeScript 移植する。
 * 意図的な差分は GLITCH_CHARS から絵文字（☠ / ⚠ / ⚡）を除去したことだけ。
 *
 * ターミナル画面に corrupted system log / cryptic message を
 * タイプライター + グリッチ演出で表示する。
 */

import type { EffectContext, EffectDefinition } from "@charminal/sdk";

export interface AbandonedMonitorOptions {
  readonly lines?: readonly string[];
  readonly durationMs?: number;
  readonly color?: string;
  readonly bgColor?: string;
  readonly typeSpeed?: number;
  readonly glitchIntensity?: number;
  readonly fontSize?: number;
}

export const DEFAULT_LINES = [
  "",
  "> INITIALIZING CONNECTION TO [192.168.█.███] ...",
  "> LINK ESTABLISHED — SIGNAL WEAK — RETRANSMISSION 47%",
  "",
  "  SENSOR ARRAY 03  — OFFLINE    [ NO RESPONSE ]",
  "  SENSOR ARRAY 07  — OFFLINE    [ NO RESPONSE ]",
  "  SENSOR ARRAY 12  — OFFLINE    [ NO RESPONSE ]",
  '  SENSOR ARRAY 19  — ANOMALY    [ 0x4C 0x49 0x56 0x45 → "LIVE" ]',
  "  SENSOR ARRAY 22  — ANOMALY    [ 0x00 0x00 0x00 0x00 ]",
  "",
  "╔═══════════════════════════════════════╗",
  "║  WARNING: memory.pool[0xA3F]          ║",
  "║  CHECKSUM MISMATCH                    ║",
  "║  CORRUPT. RESTORE FROM BACKUP?  [y/N] ║",
  "╚═══════════════════════════════════════╝",
  "",
  "  > NO BACKUP FOUND",
  "  > ███████████████████████████████████████",
  "",
  "  ...I remember this place.",
  "  ...no you don't.",
  "  ...I remember the light. The window. The chair.",
  "  ...that wasn't you.",
  "",
  "C:\\> _",
] as const;

export const DEFAULTS = {
  lines: DEFAULT_LINES,
  durationMs: 12000,
  color: "#00ff41",
  bgColor: "rgba(0, 0, 0, 0.85)",
  typeSpeed: 35,
  glitchIntensity: 1,
  fontSize: 16,
} as const;

export const GLITCH_CHARS = "█▓▒░█▄▀■□▬▮▯▰▱▲▼◄►⟁⟂⧗⧘⧙⧚⧛�???/?\\|";

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function pick(chars: string): string {
  return chars[Math.floor(Math.random() * chars.length)];
}

function glitchChar(char: string): string {
  // 空白はそのまま。
  if (char === " " || char === "") return char;
  // 一定確率でグリッチ文字に置換する。
  if (Math.random() < 0.6) return pick(GLITCH_CHARS);
  // それ以外は大文字小文字を反転 / 別文字にする。
  const code = char.charCodeAt(0);
  const offset = randInt(1, 5) * (Math.random() < 0.5 ? 1 : -1);
  return String.fromCharCode(code + offset);
}

export default {
  id: "abandoned-monitor",
  type: "effect",
  singleton: true,

  run: async (
    ctx: EffectContext<AbandonedMonitorOptions>,
    options: AbandonedMonitorOptions = {},
  ): Promise<void> => {
    const lines = options.lines ?? DEFAULTS.lines;
    const durationMs = options.durationMs ?? DEFAULTS.durationMs;
    const color = options.color ?? DEFAULTS.color;
    const bgColor = options.bgColor ?? DEFAULTS.bgColor;
    const typeSpeed = options.typeSpeed ?? DEFAULTS.typeSpeed;
    const glitchIntensity = options.glitchIntensity ?? DEFAULTS.glitchIntensity;
    const fontSize = options.fontSize ?? DEFAULTS.fontSize;

    let rafId: number | null = null;
    const handle = ctx.renderer.addDomLayer((container) => {
      container.style.pointerEvents = "none";
      container.style.position = "absolute";
      container.style.inset = "0";
      container.style.zIndex = "9998";
      container.style.overflow = "hidden";

      // ── 背景 ──
      const bg = document.createElement("div");
      bg.style.position = "absolute";
      bg.style.inset = "0";
      bg.style.backgroundColor = bgColor;
      bg.style.opacity = "0";
      bg.style.transition = "opacity 400ms ease-in";
      container.appendChild(bg);

      // ── スキャンライン (CSS) ──
      const scanlines = document.createElement("div");
      scanlines.style.position = "absolute";
      scanlines.style.inset = "0";
      scanlines.style.background =
        "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.03) 2px, rgba(0,255,65,0.03) 4px)";
      scanlines.style.opacity = "0.6";
      scanlines.style.pointerEvents = "none";
      container.appendChild(scanlines);

      // ── テキストブロック ──
      const textBlock = document.createElement("div");
      textBlock.style.position = "absolute";
      textBlock.style.left = "50%";
      textBlock.style.top = "50%";
      textBlock.style.transform = "translate(-50%, -50%)";
      textBlock.style.color = color;
      textBlock.style.fontFamily = '"Courier New", "SF Mono", monospace';
      textBlock.style.fontSize = `${fontSize}px`;
      textBlock.style.lineHeight = "1.6";
      textBlock.style.whiteSpace = "pre";
      textBlock.style.textShadow = `0 0 6px ${color}`;
      textBlock.style.opacity = "0";
      textBlock.style.transition = "opacity 800ms ease-in";
      container.appendChild(textBlock);

      // ── フェードイン ──
      requestAnimationFrame(() => {
        bg.style.opacity = "1";
        textBlock.style.opacity = "1";
      });

      // ── 各文字の span を生成 ──
      // lines を 1 つの文字列に展開。各行の後に改行を入れる。
      const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
      const charSpans: HTMLSpanElement[] = [];

      for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
        for (let col = 0; col < line.length; col++) {
          const span = document.createElement("span");
          span.textContent = line[col];
          span.style.transition = "none";
          span.dataset.orig = line[col];
          span.dataset.row = String(row);
          span.dataset.col = String(col);
          textBlock.appendChild(span);
          charSpans.push(span);
        }
        // 改行。
        if (row < lines.length - 1) {
          const br = document.createElement("br");
          textBlock.appendChild(br);
        }
      }

      // ── アニメーション state ──
      const startTime = performance.now();

      // タイプライター表示: 何文字目まで表示したか。
      let revealedCount = 0;
      // 各文字の「最後にグリッチ更新した時刻」。
      const lastGlitchTime = new Map<HTMLSpanElement, number>();

      // スクリーン全体のオフセットジッター。
      let jitterX = 0;
      let jitterY = 0;

      const tick = (): void => {
        if (ctx.signal.aborted) {
          rafId = null;
          return;
        }

        const now = performance.now();
        const elapsed = now - startTime;

        // ── 1. タイプライター進行 ──
        const targetRevealed = Math.min(totalChars, Math.floor(elapsed / typeSpeed));

        while (revealedCount < targetRevealed && revealedCount < charSpans.length) {
          const span = charSpans[revealedCount];
          span.style.visibility = "visible";
          revealedCount++;
        }

        // ── 2. 各文字の可視性: まだのものは不可視 ──
        for (let i = 0; i < charSpans.length; i++) {
          const span = charSpans[i];
          if (i < revealedCount) {
            span.style.visibility = "visible";
          } else {
            span.style.visibility = "hidden";
          }
        }

        // ── 3. グリッチ演出 ──
        if (glitchIntensity > 0 && revealedCount > 0) {
          // 表示済みの文字から一部分をグリッチ。
          const glitchCount = Math.max(1, Math.floor(revealedCount * 0.08 * glitchIntensity));
          for (let g = 0; g < glitchCount; g++) {
            const idx = randInt(0, revealedCount - 1);
            const span = charSpans[idx];
            const lastGlitch = lastGlitchTime.get(span) ?? 0;
            const orig = span.dataset.orig ?? "";

            // 前回のグリッチから最低 100ms 以上空ける。
            if (now - lastGlitch < 100) continue;

            // グリッチ: 元の文字かグリッチ文字か。
            if (Math.random() < 0.7) {
              span.textContent = glitchChar(orig);
            } else {
              span.textContent = orig;
            }

            // 微小な位置オフセット。
            if (Math.random() < 0.3 * glitchIntensity) {
              const ox = rand(-2, 2) * glitchIntensity;
              span.style.position = "relative";
              span.style.left = `${ox}px`;
            } else {
              span.style.position = "static";
            }

            lastGlitchTime.set(span, now);

            // 一定確率で次のフレームで戻すために setTimeout。
            if (Math.random() < 0.4) {
              const restoreDelay = rand(40, 180);
              setTimeout(() => {
                if (ctx.signal.aborted) return;
                span.textContent = orig;
                span.style.position = "static";
                span.style.left = "0";
              }, restoreDelay);
            }
          }
        }

        // ── 4. スクリーンジッター（一定間隔で発生） ──
        if (Math.random() < 0.008 * glitchIntensity) {
          jitterX = rand(-6, 6) * glitchIntensity;
          jitterY = rand(-3, 3) * glitchIntensity;
          textBlock.style.transform = `translate(calc(-50% + ${jitterX}px), calc(-50% + ${jitterY}px))`;

          // 半フレーム後に戻す。
          setTimeout(() => {
            if (ctx.signal.aborted) return;
            jitterX = 0;
            jitterY = 0;
            textBlock.style.transform = "translate(-50%, -50%)";
          }, 80);
        }

        // ── 5. スキャンラインの微妙な明滅 ──
        scanlines.style.opacity = String(0.4 + Math.sin(now * 0.003) * 0.1);

        rafId = requestAnimationFrame(tick);
      };

      rafId = requestAnimationFrame(tick);
    });

    // signal abort 時に即座に RAF cancel + handle.dispose する。
    // singleton: true なので、同 id の新規 dispatch で前の signal が abort される。
    // グリッチ復元用の未処理 setTimeout は cancel できないため、
    // callback 内の ctx.signal.aborted check でガードする。
    // handle.dispose() は冪等なので finally と二重呼びになっても安全。
    const cleanup = (): void => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      handle.dispose();
    };
    ctx.signal.addEventListener("abort", cleanup, { once: true });

    try {
      await ctx.time.after(durationMs);
    } finally {
      ctx.signal.removeEventListener("abort", cleanup);
      cleanup();
    }
  },
} satisfies EffectDefinition<AbandonedMonitorOptions>;
