# Quiet Idle reference correction

The reported symptom was a shoulder held lower for roughly 8–10 seconds while
the lower body barely moved. The exact clip playing during that observation was
not traced, so this report does not identify it from the screenshot. A separate,
reproducible mechanism exists in the distributed `Idle.vrma`: its upper body has
a fixed torso counter-lean that depends on the source hips stance. Playing that
upper body over the rest-relative standing foundation loses this relationship.

With actual Yori, actual `AnimationPlayer`, upper weight 0.9, and the same lower
foundation in both cases, the uncorrected shoulder line stays at 12.916–13.462°
through the 8.333-second clip. This is not a transient blend artifact. The
measurement uses the upper-arm joint centers; a positive angle means the
anatomical right shoulder is lower.

Only the reviewed `anim:Idle` **upper-body loop** is now prepared as
`q_rest * inverse(q_source(0)) * q_source(t)`. The immutable relaxed target rest
is captured when the player is constructed. Calibration covers the entire
upper chain, including head, arms and fingers: removing only the torso offset
would leave the source's head counter-tilt. This adds no finger axis conversion;
the model's regular relaxed rest already supplies the finger shape. The source
clip is unchanged, preparation is cached, and the existing loop conditioner is
applied afterward. Invalid or unsuitable calibration fails closed.

This is a correction to one quiet reference pose. It does not remove deliberate
asymmetry from other clips, alter explicit full-body playback, restore missing
source hip translation, or make an upper-body mask suitable for weight shifts.
Intentional leaning still requires the authored hips and legs to move together.

The committed [metrics](quiet-idle-calibration-metrics.json) are reproducible with
`node scripts/measure-quiet-idle-calibration.mjs`. They use the current Yori and
Idle asset hashes, 500 frames at 60 Hz per lane, four upper weights (0.2, 0.5,
0.9, 1), no procedural overlays, and the same lower foundation. At weight 0.9:

| Measurement | Before | Calibrated |
| --- | ---: | ---: |
| Shoulder line range, degrees | 12.916 to 13.462 | −0.314 to 0.271 |
| Head up-vector roll, degrees | −4.399 to −3.617 | −0.268 to 0.495 |
| Maximum ankle/toe displacement, mm | 1.286 | 1.286 |

All 43 upper quaternion tracks and 10,793 source samples preserve their recorded
local rotation changes before loop conditioning (maximum error 8.94e−8 radians).
The four lower support trajectories are identical between cases. Unit and real
Three.js mixer regressions cover noncommuting rotations, fingers, immutable
loading references, repeated cached playback, invalid inputs, and unchanged
full-body/non-loop/other-clip variants.

Five paired browser images at source phases 0, 2, 4, 6 and 8 seconds are saved
locally in `.motion-review/quiet-idle-replay/phase-*.png`, with raw joint markers
in `observations.json`. The visible shoulder/head tilt is removed without a new
obvious upper-chain deformation in those images. The browser reported no page
or resource failures. Still images do not establish continuous perceptual
quality, and these measurements are not an Animates superiority comparison.
