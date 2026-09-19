# Diagnose the final composed motion

Status: implemented for development diagnostics; perceptual thresholds remain provisional.

`Body` samples its normalized skeleton after all body layers and `vrm.update`.
The monitor observes the resulting pose without changing it. A discontinuity in
a source recording, a transition, an overlay or a delayed frame can otherwise
look similar while requiring different fixes.

## What is recorded

The fixed buffers retain 120 frames and 32 events. Up to 22 available major bones
cover hips, torso, head, shoulders, arms, hands, legs, feet and toes. A frame
contains local quaternions and avatar-space joint origins, plus elapsed Body
time and its supplied delta. The context includes actual performance phase,
weight and overlapping-action count, recorded support unit and phase, upper
gain, conversation/activity, configured/effective intensity and animation claim.

Routine `getRecordedBodySnapshot().composedMotion` exposes counts and recent
suspects. `getComposedMotionSnapshot(true)` explicitly exports the numeric pose
ring for a development review. Steady sampling uses preallocated pose/context
buffers; event creation and explicit exports allocate. This is an in-memory
diagnostic, not persistent telemetry or a recording of conversation content.

## How to interpret a suspect

Angular prediction uses shortest-arc parent-space quaternion velocity; changing
between equivalent `q` and `-q` does not count as motion. Translation prediction
uses local offsets so a smoothly rotating limb's curved path is not itself an
error. Avatar-space positions are retained for inspection. A pose candidate
must exceed both a prediction-error filter and a time-aware acceleration filter.
Constant fast rotation alone does not trigger the detector.

| Filter | Initial value |
| --- | --- |
| Frame stall | 100 ms supplied delta |
| Angular prediction error | 0.05 rad |
| Angular acceleration | 120 rad/s² |
| Local translation prediction error | 15 mm |
| Linear acceleration | 25 m/s² |

These are engineering filters, not published biomechanical limits or a
naturalness score. Intentional rapid movement can trigger them; small visible
vibration can remain below them. Zero/invalid delta, pauses and long frames reset
derivative history so resuming does not manufacture an acceleration spike.
Frame stalls and invalid samples are separate event types.

Inspect a candidate with the clip phases, gains and nearby frames. Determine
whether the cause is source acting, composition, a handoff or frame delivery;
then reproduce and correct that cause. For example, contiguous reviewed units
of the same source can play as an uninterrupted range instead of asynchronously
holding and fading at an internal split. This requires an unambiguous continuation
with identical context, reference pose, hand and contact policies; the extended
endpoint still passes the target contact gate. The low-level player also avoids
a frozen-pose fade for an immediately adjacent compatible continuation with stable
gains. Unrelated clips still use their normal gates.

## Limits and verification

The trace excludes fingers, eyes, skinned clothing intersections and scene/camera
placement. A fixed 120-frame ring has a variable duration, approximately two
seconds at 60 Hz. Only the latest actual performance is named when actions
overlap; the overlap count flags that this is not a full mixer dump. An exported
trace supports pose inspection, not exact resimulation of every asynchronous
event. Pair it with asset hashes, revision, camera and scenario information from
the [review template](../templates/motion-quality-review.md).

Tests cover smooth fast motion at 30/60/120 Hz and uneven deltas, quaternion sign
changes, discontinuities, stalls, invalid samples, resets, bounded storage,
export isolation and observation after `vrm.update`. Tests do not establish
perceptual acceptance or native compositor performance. Use the
[recurring quality review](motion-quality-review.md) for those separate checks.
