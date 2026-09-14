# Contextual use of the September 15 Mixamo recordings

The user supplied seven original FBX recordings and requested review of the complete performances before assigning idle or conversational uses. All seven were converted with their original 30 Hz timestamps, 52 bone rotation tracks, 30 finger tracks, and authored hips XYZ variation. The original files remain in `../Yorishiro-assets/sources/`. Conversion fidelity and provenance are recorded in `mixamo-source-conversion.json`; source attribution and license links are in `CREDITS.md` and `mixamo-idle-import.md`.

## Playback decisions

| Source | Use | Constraints |
| --- | --- | --- |
| Hands Forward Gesture | A short explanatory emphasis | Full 3.1-second phrase, once; never a looping speech baseline. |
| Fist Pump | Explicit achievement or strong joy | Full 3.8-second phrase, once; ordinary agreement or thanks does not trigger it. |
| Thoughtful Head Shake | Reconsideration or uncertainty | Full 3.067-second reaction, once; not continuous head movement while idle. |
| Shrugging | Explicit uncertainty | Full 2-second phrase, once; clip-specific maximum upper-body weight 0.8. |
| Warrior Idle | An occasional chest/arm stretch | Use original seconds 5–10, including arms down before and after opening. The 13.3-second full source remains available separately. |
| Sad Idle | A whole-body expression of disappointment | Not automatically admitted yet: its foot action is essential, and the current base cannot safely resume after the full-body performance. |
| Texting While Standing | Taking out, using, and putting away a phone | Manual/contextual asset for a scene with a phone prop; absent from automatic selection when the character has no phone. |

The stretch shares the existing 90–150 seconds of eligible quiet time with the safe raised-hand survey. Compatible alternatives are selected without immediately repeating the same performance when another is available. These finite performances remain separate from the 15–25-second ordinary posture-change schedule. Listening, speaking, explicit ownership, and reduced-motion settings still take precedence; the existing supporting legs continue under the upper-body gestures.

## Actual-model review

Each original was replayed from beginning to end on Yori in front and oblique views, with continuous 24 fps video and chronological image sheets. The four conversational gestures and the stretch were then replayed over both existing D/A lower-body recordings. All sampled hips, ankles and toes matched the independent base-only control exactly. Visual review found no new wrist inversion, collapsed torso, or abrupt return in those compositions. Clothing obscures some joints; this is not a per-vertex collision proof.

The existing finite-entry gate was evaluated at 35 D phases and 31 A phases. Hands Forward, Fist Pump, Thoughtful Head Shake and Warrior Stretch passed all 66 at weight 1. Shrugging failed at weight 1 because the left upper-arm entry difference was approximately 1.463 radians, exceeding the existing 1.2-radian limit. At weight 0.8 it passed all 66 and retained a clear palms-up shrug in the composed visual review. The general gate was not widened.

Sad Idle contains a backward leg lift and forward kick/shuffle. Full-body playback through actual Body completes, but returning to the existing Around base fails its entry contact-position limit before fade validation. After the common root offset is aligned, the four foot/toe support points retain 45.5–57.8 mm horizontal error versus the existing 10 mm limit; height errors remain within 5 mm. This is a different stance, not simply a wrong floor height. Replaying only its upper half would remove the authored weight-shift acting. The automatic catalog therefore does not disguise the incompatibility with an upper-body substitute.

Private videos, image sheets, full phase measurements and the actual-Body Sad return attempt are under `.motion-review/mixamo-visual-20260915/`; `index.html` is the local review gallery. Installed bytes are checked against `mixamo-motion-review.json` during asset bundling. These results establish conversion fidelity and the reviewed composition constraints, not superiority over Animates.

## Integrated playback validation

A deterministic 562.43-second run exercised the actual Yori Body, AnimationMixer, installed catalog and speech-expression bridge. It included six utterance attempts followed by six minutes of quiet time, with 33,746 sampled frames, no missing recorded-body base and no runtime errors. Explicit success, emphasis and uncertainty selected Fist Pump, Hands Forward, Shrugging and Thoughtful Head Shake. The phrase `検討してみます。` was not recognized by the existing consideration rule and correctly remained a baseline gesture; it is not evidence of that intent being recognized. Warrior Stretch appeared autonomously, yielded to a new utterance, and later completed a full five-second performance.

The four admitted conversational performances remained active after their short utterances ended and returned naturally. This run used measured speech timings and a controlled clock, not an audible end-to-end speech-service test. Separate regression tests cover cancellation, replacement, completed-utterance handle ownership and the microtask ordering of voice completion. Reviewed one-shot reactions may repeat after their own cooldown, including an isolated second success after 90 seconds; continuous baseline and idle repetition rules are unchanged.

The complete Body suite passed 592 tests. The final speech/cancellation changes passed 158 related tests, and the cooldown changes passed 103 catalog/director/Body tests; TypeScript and the production frontend build passed. Private observations and after-speech captures are in `.motion-review/mixamo-runtime-final/`.
