/**
 * Stage transition — UI pack の「ステージが開く / 閉じる」アニメーション。
 *
 * theater のような fullscreen UI pack が opt-in する（`UiLayout.transition.kind === "stage"`）。
 * presence の sidebar 開閉と同じ TweenManager（RAF 駆動）に乗せる——CSS transition は
 * presence の per-frame な --sidebar-width tween と衝突するため使わない。
 *
 * シーケンス:
 *   open  : ① chrome 行を上へ引っ込め（translateY 0→-100%）→ ② shell/character を 280px→100vw
 *   close : ① shell/character を 100vw→280px → ② chrome 行を下ろす（translateY -100%→0）
 *
 * 感触値（ms / easing）は帰納的に調整する前提。
 */

import { easeInOutCubic } from "../../core/tween/lerp";
import type { TweenManager } from "../../core/tween/tween-manager";

/** stage 遷移で動かす 3 つの surface。 */
export interface StageSurfaces {
  /** shell-column（width を 280↔100vw）。 */
  readonly shell: HTMLElement;
  /** charactor-container（width を 280↔100vw、ResizeObserver 経由で canvas/camera が追従）。 */
  readonly character: HTMLElement;
  /** chrome 行（.sidebar、translateY で上下）。 */
  readonly chrome: HTMLElement;
}

export interface StageTransitionDeps {
  readonly tweenManager: TweenManager;
  /** 100vw を px に解決する（通常 window.innerWidth）。 */
  readonly viewportWidth: () => number;
}

/** 畳んだ状態の幅。App.css の --sidebar-width / --sidebar-content-width 初期値に一致。 */
const COLLAPSED_WIDTH_PX = 280;
/** chrome の上下スライド時間（感触値、帰納調整）。 */
const CHROME_MS = 1000;
/** shell/character の開閉時間（感触値、帰納調整）。 */
const WIDTH_MS = 2500;

/**
 * 連続 toggle 時に in-flight な遷移の完了 callback が最終状態を上書きしないための世代 token。
 * 同一 key の tween は TweenManager 側で cancel されるが、phase 境界の clean-up は自前で guard する。
 */
let generation = 0;

function tweenTo(
  tm: TweenManager,
  key: string,
  from: number,
  to: number,
  durationMs: number,
  setter: (v: number) => void,
): Promise<void> {
  const handle = tm.start(key, to, durationMs, setter, { from, easing: easeInOutCubic });
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // ThreeRuntime が pause / hidden state から復帰できない場合でも、fullscreen UI pack は
    // 最終 layout へ必ず到達させる。通常は completion が先に resolve するので visual には影響しない。
    const timer = setTimeout(() => {
      setter(to);
      handle.cancel();
      finish();
    }, durationMs + 100);
    handle.completion.then(finish, finish);
  });
}

/**
 * stage を開く / 閉じる。呼び出し前提:
 *   open  — applyLayout が end-state を適用済み。本関数が animated prop を start から tween。
 *   close — resetLayout が clear 済み。本関数が end-state から start へ tween し、最後に inline を戻す。
 */
export async function playStageTransition(
  direction: "open" | "close",
  surfaces: StageSurfaces,
  deps: StageTransitionDeps,
): Promise<void> {
  const { tweenManager: tm } = deps;
  const vw = deps.viewportWidth();
  const gen = ++generation;
  const isCurrent = () => gen === generation;

  const setShell = (w: number) => {
    surfaces.shell.style.width = `${w}px`;
    surfaces.shell.style.minWidth = `${w}px`;
    surfaces.shell.style.flexBasis = `${w}px`;
  };
  const setChar = (w: number) => {
    surfaces.character.style.width = `${w}px`;
    surfaces.character.style.minWidth = `${w}px`;
  };
  // chrome を marginTop で上へ動かす。負の marginTop は「上へスライド」＋「占有スペースを
  // 畳む」を同時に満たすため、下の character が retract に合わせて上へ詰める（要望 B）。
  const setChromeMargin = (px: number) => {
    surfaces.chrome.style.marginTop = `${px}px`;
  };

  if (direction === "open") {
    // applyLayout は chrome を display:none・shell/char を 100vw にしている。
    // start 値へ上書き（同一 sync block 内なので paint 前、ちらつかない）。
    surfaces.chrome.style.display = "";
    surfaces.chrome.style.marginTop = "0px";
    // 退避量＝chrome の現在高さ（display 復帰後に測れる）。
    const chromeH = surfaces.chrome.offsetHeight || 0;
    setShell(COLLAPSED_WIDTH_PX);
    setChar(COLLAPSED_WIDTH_PX);

    // ① chrome を上へ引っ込め、占有スペースごと畳む（character が上に詰める）
    await tweenTo(tm, "stage.chrome", 0, -chromeH, CHROME_MS, setChromeMargin);
    if (!isCurrent()) return;
    surfaces.chrome.style.display = "none";
    surfaces.chrome.style.marginTop = "";

    // ② shell/character を全画面へ
    await Promise.all([
      tweenTo(tm, "stage.shell", COLLAPSED_WIDTH_PX, vw, WIDTH_MS, setShell),
      tweenTo(tm, "stage.char", COLLAPSED_WIDTH_PX, vw, WIDTH_MS, setChar),
    ]);
    if (!isCurrent()) return;
    // clean end-state（applyLayout と一致させ、responsive な 100vw に戻す）
    surfaces.shell.style.width = "100vw";
    surfaces.shell.style.minWidth = "100vw";
    surfaces.shell.style.flexBasis = "100vw";
    surfaces.character.style.width = "100vw";
    surfaces.character.style.minWidth = "100vw";
    return;
  }

  // close — resetLayout が inline を clear 済み（shell/char は CSS 280px、chrome は
  // display:"" / marginTop なし）。end-state へ上書きしてから start へ tween。
  setShell(vw);
  setChar(vw);
  // chrome を可視化して退避量を測り、畳んだ（上へ退避した）状態から開始する。
  surfaces.chrome.style.display = "";
  const chromeH = surfaces.chrome.offsetHeight || 0;
  setChromeMargin(-chromeH);

  // ① shell/character を畳む
  await Promise.all([
    tweenTo(tm, "stage.shell", vw, COLLAPSED_WIDTH_PX, WIDTH_MS, setShell),
    tweenTo(tm, "stage.char", vw, COLLAPSED_WIDTH_PX, WIDTH_MS, setChar),
  ]);
  if (!isCurrent()) return;
  // inline を外して CSS（--sidebar-width / --sidebar-content-width）へ返す
  surfaces.shell.style.width = "";
  surfaces.shell.style.minWidth = "";
  surfaces.shell.style.flexBasis = "";
  surfaces.character.style.width = "";
  surfaces.character.style.minWidth = "";

  // ② chrome を下ろす（占有スペースが戻り、character が下がる）
  await tweenTo(tm, "stage.chrome", -chromeH, 0, CHROME_MS, setChromeMargin);
  if (!isCurrent()) return;
  surfaces.chrome.style.marginTop = "";
}
