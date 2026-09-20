export const CONTACT_SHEET_FRAME_COUNTS = [4, 9, 16, 25] as const;

/** One frame sends a still image; larger counts build a chronological sheet. */
export function isValidContactSheetFrameCount(value: number): boolean {
  return (
    value === 1 ||
    CONTACT_SHEET_FRAME_COUNTS.includes(value as (typeof CONTACT_SHEET_FRAME_COUNTS)[number])
  );
}
