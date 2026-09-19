import type { FootContactProfile } from "./foot-contact";

/**
 * Long stationary source episodes from recorded-contact-candidates.json. Times
 * belong to the hash-verified 30 Hz conversions, including their 0.1 s in-point.
 * Both ankle and toe must remain within 15 mm for at least two seconds. Short
 * contacts and heel lifts are deliberately absent. These are data for the common
 * runtime solver, not different correction code or gains for each performance.
 */
export const REVIEWED_FOOT_CONTACTS: Readonly<Record<string, FootContactProfile>> = {
  "anim:Idle Chatting": {
    sourceSha256: "d485a7dabb21d4b8809433a23ddf68a43ba5a31761d7106925c6bd8917e56e0d",
    durationSec: 26.73326683,
    left: [
      [2.83333333, 16.58333333],
      [19.06666667, 25.43333333],
    ],
    right: [[3.33333333, 24.81666667]],
  },
  "anim:Idle Chatting 2": {
    sourceSha256: "b0c1a26c46e24e03b9fef3b5c61977fea814921f2293527cb3f0706ed39fd4d2",
    durationSec: 41.73303986,
    left: [[2.23333333, 40.18333333]],
    right: [[1.66666667, 39.51666667]],
  },
};
