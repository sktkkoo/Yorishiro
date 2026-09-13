# Conversation retarget acceptance

Status: source-fidelity gate passed; uncorrected Yori whole-body contact gate remains open.

The prepared Conversation restores authored hips translation and preserves the recording's rotations. It substantially reduces the foot movement caused by the old translation-free conversion. It still requires a small, explicitly separate target adaptation before claiming stable planted feet on Yori.

Reproduce with `node scripts/measure-conversation-retarget.mjs`. Inputs and hashes, the 60 Hz trajectories, source-derived support intervals and skinned-shoe measurements are recorded in [conversation-retarget-metrics.json](conversation-retarget-metrics.json). The previous [source roundtrip](source-faithful-conversation-metrics.json) remains a separate test of data preservation.

| Measurement | Existing VRMA on Yori | Source-faithful VRMA on Yori |
| --- | ---: | ---: |
| Left support-foot horizontal displacement | 82.25 mm | 12.65 mm |
| Right support-foot horizontal displacement | 77.87 mm | 14.43 mm |
| Left shoe minimum-height range above its rest floor | 7.62–20.77 mm | 4.04–6.95 mm |
| Right shoe minimum-height range above its rest floor | 9.10–26.07 mm | 4.39–10.60 mm |

The support measurements use the same inferred quiet source interval, 0.15–25.0 seconds, for both sides and both Yori versions. The source feet themselves move 7.09 mm left and 4.81 mm right within that interval. These are provisional support labels based on low ankle/toe velocity and low toe height, not independently authored ground-truth contact annotations. Full-clip first/last movement is retained and reported separately.

Floor measurements use 348 actual skinned vertices per shoe, selected by foot/toe skin influence and rest height. The model's rest shoe minima are effectively at world Y=0. Ankle and toe bone origins are above the soles, so their Y coordinates alone are not treated as penetration or clearance. The CPU evaluator agrees with 30 independently captured browser hip/foot checkpoints within 6.91e-9 metres (including report rounding).

## Why source fidelity does not guarantee target contact

The official translation scale is finite and correct for its documented calculation: Yori rest hip height / source rest hip height = 0.9192216 / 0.8902914 = 1.032495. It preserves the source hip path with that single scale. Raw and normalized Yori hip/foot positions agree in the audit; the residual is not an unapplied humanoid update or coordinate-flip error.

Yori is not uniformly scaled from the source skeleton. Its thigh segment is 0.356985 m versus 0.409155 m in the source, while the shin is 0.411638 m versus 0.410102 m. Its ankle-to-toe segment is 0.113790 m versus 0.137839 m. The same normalized rotations and one hip-height scale therefore do not keep both support feet on the same trajectories or put the shoes on the floor.

The converter's static non-hips translation bake is necessary for accurate replay on the source skeleton. The official retargeter uses the target's own non-hips reference geometry; those source offsets are not copied into Yori's limb lengths. Changing Yori's reference lengths to force a roundtrip would alter the character model and is not proposed.

## Bounded next gate

Keep the source-faithful candidate immutable. Create a separate Yori-specific Conversation candidate, preserving the authored full-body/hand rotations and time-varying hips path as the baseline. First quantify a small common hips translation correction; use constrained leg/foot adjustment only if both feet cannot satisfy the contact tolerance together. Smooth the entry and release around the provisional support interval and measure knee/pole stability, angle changes, remaining shoe clearance/penetration and horizontal support motion.

This review does not approve arbitrary full-body assets, looping this excerpt, cross-clip transitions or dance IK. It does not establish perceptual superiority over Animates.

## Separate target adaptation experiment

`node scripts/adapt-conversation-contacts.mjs` now creates a private `Idle Conversation.yori-contact.vrma` alongside the immutable source-faithful candidate. The tool checks the exact Conversation and Yori hashes. The [adaptation report](conversation-contact-adaptation-metrics.json) records this as target correction, not a new source-fidelity result.

A hips-only correction of at most 12.71 mm leaves 4.06 mm horizontal support-point residual and 5.39 mm shoe clearance. The selected correction adds authored-pole two-bone leg IK and preserves each foot's authored world orientation. The common root correction is at most 13.80 mm, including 1.75 mm of constant reach padding under the contact envelope; the remaining independent ankle adjustment is at most 5.24 mm. The largest leg-local rotation change is 6.38 degrees at the right knee. Upper-body, fingers, hips rotation and their time keys remain unchanged.

The contact envelope ramps smoothly over 0.35 seconds at either end of the provisional 0.15–25.0-second interval. The exported candidate is reloaded through the official VRMA path and evaluated at 120 Hz, independently of the 60 Hz bake:

| Exported target check | Maximum error |
| --- | ---: |
| Contact-center horizontal error during full lock | 0.0107 mm |
| Individual ankle/toe horizontal movement, retaining authored foot rotation | 1.857 mm |
| Shoe clearance during full lock | 0.0725 mm |
| Shoe penetration during full lock | 0.0046 mm |
| Foot world-orientation difference | 0.000683 degrees |

The knees retain at least 2.68 degrees of bend, and adjacent sampled knee-plane normals have a dot product of at least 0.999955; the solver does not flip to an opposite knee pole. Original hip X/Y/Z ranges of 97.93/12.64/44.74 mm become 88.24/19.79/41.16 mm, rather than being removed. The extra vertical range includes the smooth lowering into and release from target contact.

These numerical checks permit the separate visual contact review. They do not approve general reuse or production catalog replacement. The lock/release behavior, original performance and the beginning/end of the excerpt remain visible review subjects.
