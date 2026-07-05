/** 5 母音のブレンド重み。VRM lip blendShape への入力値。 */
export interface MouthValues {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
}

export const ZERO_MOUTH: Readonly<MouthValues> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

export const MOUTH_KEYS: ReadonlyArray<keyof MouthValues> = ["aa", "ih", "ou", "ee", "oh"];

export function createMouthValues(): MouthValues {
  return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
}

export function clearMouthValues(target: MouthValues): MouthValues {
  target.aa = 0;
  target.ih = 0;
  target.ou = 0;
  target.ee = 0;
  target.oh = 0;
  return target;
}

export function copyMouthValues(source: Readonly<MouthValues>, target: MouthValues): MouthValues {
  target.aa = source.aa;
  target.ih = source.ih;
  target.ou = source.ou;
  target.ee = source.ee;
  target.oh = source.oh;
  return target;
}
