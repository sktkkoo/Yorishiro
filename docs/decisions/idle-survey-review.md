# Preserve the survey gesture, exclude the hanging wrist fold

The user's two examples concern a lowered right arm with the hand folded outward. They explicitly want to retain the distinct gesture that raises the right hand above the head while looking around, at a lower frequency. Checking the currently active reference after an image was taken does not uniquely identify the pose during its outgoing crossfade.

Offline replay on Yori reproduced the lowered-arm fold in `Idle Watching Something` throughout the recording (right elbow-to-wrist versus wrist-to-middle-base angle 81.2–90.7 degrees at full weight, 66.9–74.9 degrees at catalog weight × 0.95). It also reproduced the fold in the prefix and tail of the full `Idle Looking Around` and `Idle Looking Around 2` recordings. The old whole-clip Around reaches 80.2 degrees near 33.6 seconds; Around 2 reaches 77.6 degrees near 33.2 seconds. Those complete files should not run as automatic loops. Watching should be excluded from automatic selection.

`VRMA_06_HandOnHip` did not reproduce that defect: its right wrist is 19.1–23.0 degrees at full weight and 15.5–18.7 degrees at the current weighted setting. Viewed phases 1.72 and 6.9 seconds showed a relaxed lowered right hand. An independent Watching-to-HandOnHip 800 ms player fade still has a 71-degree outgoing wrist bend after 100 ms and reaches 18 degrees at completion. Thus an active HandOnHip label can accompany the previous pose during a transition; this does not establish that the user's first capture was exactly that transition. Keep HandOnHip unless a separate defect is demonstrated.

These source references are documented in `CREDITS.md`: Around/Watching are from Rokoko's Everyday Idle pack; HandOnHip is from the VRoid Project animation set. They are not the excluded video-extraction prototype. This audit identifies defective asset poses; it does not infer that a filename or creator guarantees anatomical quality.

## Finite survey unit

The desired raised-hand performance is `Idle Looking Around 2`. The reviewed interval starts with the hands down at prepared-source 5.8 seconds, raises the hand, retains the head-high survey, then returns the hand before ending at 30.5 seconds. Its duration is 24.7 seconds. The harmful setup and tail are outside this interval. It is a finite upper-body performance, never a repaired loop. Do not cut it while the hand is raised merely to make it shorter.

Reproduce the private file with:

```sh
node scripts/prepare-idle-survey.mjs
```

The script pins the already verified 30 Hz prepared source SHA, takes its existing sample indices 174–915, rebases their clock, and copies every authored quaternion and hips-position key unchanged. All 52 rotation tracks, 30 finger tracks and hips XYZ remain in the file. It changes no skeleton, speed, interpolation mode, wrist angle or finger shape. Original files remain untouched. The source preparation corresponds to original FBX 5.9–30.6 seconds; the original FBX hash remains in the output metadata. The public reference is `/animations/recorded-idle/survey.vrma`; installation is separate from this script. Exact paths, hashes and installer fields are in [idle-survey-metrics.json](idle-survey-metrics.json), under `source`, `output` and `unit.publicRef`.

At 120 Hz, 157,198 source/replay comparisons found maximum rotation difference 0.000534 degrees and hips-position difference 0.000392 mm, caused by Float32 rebased timestamps. Authored output key values are exactly equal. All timestamps increase strictly.

## Target review

At finite upper-body weight 0.95 on Yori, the maximum bend while the forearm hangs down is 21.83 degrees; the entry and exit are 10.24 and 9.21 degrees. The maximum 66.56-degree bend occurs with the hand raised near the head and belongs to the intended gesture. A single wrist-angle threshold independent of the arm pose would incorrectly reject that gesture. The unchanged full-body Around D/A units remain safe for this specific concern: dense target replay gives maximum right-wrist bends of 15.46 and 14.46 degrees, identically before and after contact adaptation.

At weight 0.5 the wrist does not reproduce the hanging-hand fold, but the hand no longer reaches the head: the closest wrist height is 160 mm below the head, with zero time inside the 150 mm near-head height band. The gesture's meaning is lost. Preserve a high enough performance weight, or skip the optional survey at low intensity; reducing all gestures indiscriminately is not a quality fix.

Private comparison images are in `.motion-review/idle-survey-qa/`: source and actual finite player at 0, 3.33, 12, 20 and 24.7 seconds for weight 0.95, plus a weight-0.5 comparison at 3.33 seconds. The inspected raised-hand and return images preserve the intended performance and show no lowered-hand outward fold. All six captures have no page errors. They use a separate local test page and do not change or capture the user's native application. These sampled images and numeric checks do not replace an entry/exit crossfade review over the actual D/A base or the user's live review.

A direct FBX re-preparation attempt exposed an existing generic helper issue: floating-point `ceil(24.7 * 30)` can emit duplicate Float32 terminal times; a clamped verification action then samples time zero on the repeated endpoint. Its guard correctly refused to write that candidate. The generic helper and existing prepared assets were not changed in this task. Trimming the verified source's strictly increasing sample times avoids that issue without altering thresholds or producing new motion.

This correction preserves a specifically requested gesture and removes demonstrably inappropriate idle poses. It does not establish superiority over Animates.
