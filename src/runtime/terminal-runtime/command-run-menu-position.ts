/**
 * command run badge の attach verb menu の表示位置を決める純関数。
 * badge の下に menu が収まらないときは上に flip し、横は画面内に clamp する。
 * terminal が画面最下部にあっても menu が viewport 外に出ないようにするための計算。
 */
export interface MenuAnchorRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
}

export interface MenuSize {
  readonly width: number;
  readonly height: number;
}

export interface MenuViewport {
  readonly width: number;
  readonly height: number;
}

export function resolveCommandRunMenuPosition(
  anchor: MenuAnchorRect,
  menu: MenuSize,
  viewport: MenuViewport,
  gap = 4,
): { readonly top: number; readonly left: number } {
  // 下に十分な空きがあれば下、なければ上へ flip。どちらも入らなければ gap で上端に寄せる。
  const fitsBelow = anchor.bottom + gap + menu.height <= viewport.height;
  const top = fitsBelow ? anchor.bottom + gap : Math.max(gap, anchor.top - gap - menu.height);
  // 横は画面右端で見切れないよう clamp。
  const left = Math.max(gap, Math.min(anchor.left, viewport.width - menu.width - gap));
  return { top, left };
}
