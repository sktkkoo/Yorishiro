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
