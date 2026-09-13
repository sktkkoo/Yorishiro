# Recorded standing Idle foundation

The reviewed `anim:Idle` supplies a continuous lower-body foundation beneath independent upper-body recordings. Hips, thighs, shins, ankles, and toes all retain the recording's correlated rotation changes. This is useful motion that should not be removed with an upper-body mask.

Directly applying the recording's absolute leg stance is unsuitable: on Yori, fading from normalized standing rest to the first authored pose relocates an ankle or toe by up to 159 mm. Root translation alone cannot repair a different leg stance. Also, this converted VRMA has zero source rest hip height, so the SDK's normal translation retarget ratio is undefined. Guessing source units or enabling the unscaled translation is inappropriate.

The preparation order is:

1. For each lower-body rotation track, compute `qRest * inverse(qSourceStart) * qSource(t)`. This aligns frame zero to the target's stable normalized standing rest and retains all recorded local rotation changes. The audited maximum change is 1.113 degrees.
2. Condition the rotation loop using the normal player preparation. This must precede support reconstruction because conditioning can change the final leg rotations.
3. On a private normalized rest skeleton, sample all four ankle/toe positions at 60 Hz. Compute their mean displacement from frame zero and add the opposite common translation to the hips. This restores the small correlated movement lost by stripping the original root, without foot IK or replacement rotations.

`calibrateStandingIdleClip` and `groundStandingIdleClip` are deliberately restricted by their caller to the reviewed `anim:Idle` lower-body variant. Other recordings, arbitrary full-body requests, and upper-body tracks are unaffected. Grounding preserves its input quaternion track objects. Both functions leave the live avatar and source clip untouched, return the original clip for invalid/missing data, and bound preparation to at most 20 seconds / 1,201 support samples. The grounding safety bounds are 30 mm common correction, 10 mm individual contact residual, and 1 mm endpoint correction mismatch; these are rejection limits, not a quality promise for other assets.

Run `node scripts/measure-standing-idle-grounding.mjs` to reproduce [the numeric report](standing-idle-grounding-metrics.json) from the sibling `Yorishiro-assets` directory. The script uses the actual `AnimationMixer`, official VRMA retargeting, Yori's normalized and SDK-updated raw skeletons, two complete loops, and 120 Hz observations. Asset hashes identify the exact recordings/model; no private app images are included.

| Playback scenario | Absolute rotations, stripped root: max foot drift | Calibrated, conditioned and grounded: max foot drift |
| --- | ---: | ---: |
| Steady weight 0 | 0 mm | 0 mm |
| Steady weight 0.2 | 1.401 mm | 0.259 mm |
| Steady weight 0.5 | 3.579 mm | 0.645 mm |
| Steady weight 1 | 7.379 mm | 1.286 mm |
| 1.2 s fade from rest, phase 0 | 161.302 mm | 1.286 mm |
| 1.2 s fade to rest, phase 0 | 159.151 mm | 0.299 mm |
| Weight 1 to 0.2, phase 0 | 122.259 mm | 0.328 mm |

The full-weight calibrated foundation's maximum hips translation is 6.733 mm; pooled foot speed p95 is 2.267 mm/s. Starting transitions at phase 2.1 seconds produces maximum drift of 1.286 mm for fade-in, 1.271 mm for fade-out and 1.337 mm for the gain change. Raw and normalized foot positions agree to the report's rounding precision. Steady-weight drift uses that weight's first frame as its anchor; fade-in starts from target rest. A common translation cannot exactly cancel nonlinear partial quaternion blends, so partial-weight results are measured rather than inferred from weight 1.

These measurements support a small standing recording beneath upper-body variations. They do not establish exact zero slip, contact preservation during arbitrary full-body stance transitions, mesh/floor collision correctness, or naturalness in the final renderer. Procedural layers and full-body handoffs still need integrated visual review. They also do not establish superiority over Animates; the comparative human judgement in [the evaluation protocol](motion-orchestration-evaluation.md) remains required.
