# Motion quality review

**Status**: active evaluation workflow; current visual acceptance remains open
**Last updated**: 2026-09-19

## Purpose

Yori should feel like one person whose movements have intention and continuity,
while remaining quiet enough to share a terminal with ongoing work. A technically
valid clip can still be inappropriate, distracting, poorly timed, or badly posed.
Evaluate those separately so that fixing one does not hide or worsen another.

This operationalizes [the motion quality strategy](motion-quality-strategy.md).
It is the recurring review procedure for changes to motion assets, selection,
composition, intensity, and rendering. It does not certify the current catalog.

## What to look at

| Dimension | Observable questions | Evidence and common traps |
| --- | --- | --- |
| Acting and context | Does the gesture fit listening, thinking, explaining, or resting? Does it express an unwanted attitude? | Review complete preparation, stroke, hold, and recovery at normal speed. An uncertain phrase does not automatically justify a shrug. A matching animation name is not evidence. |
| Pose and whole-body coordination | Are hands at a readable height? Do shoulder, elbow, wrist, torso, hips, and support foot cooperate? Is a quiet pose relaxed rather than rigid? | Inspect front and side full-body playback and the actual terminal crop. Record hand height relative to the avatar's torso, palm orientation, contact and intersections. Reducing blend weight can lower the hands instead of making the same gesture quieter. Separate head/neck rotation and gaze from camera height, pitch, tracking and perspective before correcting an upward-looking face. |
| Transition continuity | Does the outgoing act finish or reach a legitimate interruption point? Do position, orientation, velocity, and support remain plausible through the join? | Watch several seconds before and after each boundary. Record source and target phases, fade duration, ownership and acceptance/rejection. A slow frame at the top of a gesture is not necessarily an exit; a longer fade cannot repair incompatible support or an unfinished act. |
| Rhythm and repetition | Are gestures too frequent, repeated, or held too long? Is there enough quiet time? | Measure starts per eligible minute, time occupied, intervals, repeated families and repeated first choices over a multi-minute run. A per-clip cooldown alone does not prove the overall behavior is quiet. |
| Controls and visual salience | Can Calm, Normal and Lively be distinguished? Does Normal stay unobtrusive during work? Do settings retain deliberate hand poses? | Compare the same scenario, seed, camera and asset versions. Track amplitude, frequency, duration and pose separately. Current pre-change Normal is the user's reference for Lively; new Normal should be quieter. Do not interpret intensity as a license to exaggerate every joint or weaken support. |
| Frame delivery | Does the skeleton actually jump, or does presentation stall? Do camera, face, hair, audio, and terminal motion stall together? | Pair render timestamps/frame intervals and long-frame events with motion phases. Distinguish fixed-step simulation from native wall-clock playback. Average FPS and a smoothly encoded video can hide intermittent stalls. |

The dimensions form a profile, not a single score. A good frame rate does not
compensate for the wrong gesture; low acceleration does not compensate for an
unfinished action. Record **pass**, **needs work**, or **not observed** per relevant
dimension, with a timecode or measurement supporting the judgment.

For arms, inspect a **natural clearance range**, not merely zero intersection.
Skin/clothing penetration is a defect, but holding the arms artificially away from
the torso throughout the motion is also a defect. Track upper arm, elbow, forearm,
wrist and fingers through the phrase, including crossing hands, recovery, and
layer changes. Judge the rendered clothed mesh as well as the skeleton. A numeric
minimum distance is a diagnostic tied to that avatar, not universal anatomy.

Whole-body coordination is an explicit acceptance check: a moving torso with
unresponsive arms, conflicting shoulder/hip timing, or hands detached from an
intended contact can look wrong even when each source clip passes independently.
Compare source, target, and combined layers with the same camera and source phase.

## Transition contract

For each admitted performance, progressively record usable entry/exit ranges,
preparation, stroke, hold, recovery, support/contact, and whether interruption or
an upper-body mask preserves its acting. These annotations are a target contract;
the existing contact windows and pose/velocity tests do not yet supply complete
semantic phrase annotations for every clip.

Normal replacement should select a permitted outgoing boundary and a compatible
incoming phase, then evaluate the actual composed pose and speed at the weight
that will be played. If no safe join is available, continue or hold the current
valid performance and retry. Do not force a different clip because a timer expired.
Conversation interruption may require a prompt bounded recovery; test it separately
from ordinary idle replacement rather than forcing every interruption to await a
long performance's end.

A legitimate boundary need not be a stationary pose. Game-production inertialization
guidance includes transitioning while the outgoing animation is moving. Expressive
completion, entry permissions, pose/velocity compatibility and support are different
checks; a universal lowest-speed rule is not justified. Current weight fades are
not inertialization. See [Epic's primary documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-blueprint-blend-nodes-in-unreal-engine).

Adjacent ranges of the same recording deserve a separate continuity test: splitting
one source must not introduce a stop, restart, phase jump, or synthetic catch-up.
For different recordings, check the entire blend and recovery, not just its endpoints.

## Repeatable review scenarios

Keep avatar and asset hashes, build revision, seed or selection trace, camera,
scene, display/refresh rate, intensity, audio input, and capture timing with the run.
Compare the previous accepted build and candidate under matching conditions.

| Scenario | Procedure | Primary checks |
| --- | --- | --- |
| Terminal work | Observe at least five minutes of quiet idle in the ordinary terminal layout; include reading and representative output activity. | Distraction, posture occupancy, hand-on-hip repetition, supporting motion, frame stalls. |
| Conversation | Use the same short exchange with listening, thinking, a neutral explanation, one emphasis, silence, and an interruption. | Appropriate acting, readable hand positions, speech start/end, recovery and ownership changes. |
| Boundary replay | Replay each changed transition with context before and after it; include same-source adjacency, a different source, and a rejected candidate. | Phrase boundary, velocity continuity, contact, no reset-to-rest or sudden re-entry. |
| Intensity comparison | Replay the same idle/listening/explanation at 0, Calm, Normal, Lively and Over; change levels during playback as well. | Distinct levels, smooth response, zero/resume behavior, preserved speech hand pose and support. |

Five minutes is an initial observation window, not a guarantee of rare behavior.
Extend a run when the relevant cooldown, random choice, or transition did not occur.
Use normal-speed video for judgment; slow motion and pose sheets are diagnostic
supplements. Include both full-body/side views and actual terminal presentation.

## Continuous improvement loop

1. Record the user's observation as a symptom, separate from its proposed cause.
   Capture time, activity, visible region, motion IDs/phases and intensity when
   available. If the clip is unidentified, keep it unidentified.
2. Reproduce the smallest relevant scenario. Compare source playback, target replay,
   composition and native frame delivery to locate where the defect appears.
3. State one testable hypothesis and the dimension expected to improve. Change the
   responsible layer; avoid changing speed, pose, frequency and amplitude together
   without separate evidence.
4. Add a regression check for reproducible behavior or numerical continuity.
   Re-run the matching before/after scenario and adjacent affected scenarios.
5. Fill in the [review record](../templates/motion-quality-review.md). Report runtime
   checks, geometric measurements and perceptual observations separately. Preserve
   unresolved observations instead of calling them fixed because code changed.
6. Feed the result back into clip eligibility, phrase annotations, timing, parameter
   limits and regression fixtures. Link the accepted evidence from the relevant
   decision so later changes use the same standard.

Visual evidence unavailable means visual acceptance is pending. It does not prevent
preparing and testing a concrete fix, and it is not a requirement to interrupt the
user for approval on routine reversible work.

## Initial feedback ledger: 2026-09-19

These are user observations and desired outcomes, not a completed acceptance report.

| Observation | Desired outcome | Evidence needed to close |
| --- | --- | --- |
| Light shoulder-lift gesture should not be used. | Exclude the unwanted acting from automatic selection. | The snapshot immediately following the renewed report at 10:09:41 UTC showed `anim:Idle`, with the recorded body's upper layer disabled; it did not show `Shrugging`. Identify the visible shoulder motion in continuous replay before declaring exclusion complete. |
| Standing looks stiff/jerky. | Relaxed continuity without visible shaking or freezes. | Native normal-speed footage aligned with phase/owner and frame-time traces. |
| Jerk appears near a switch; transitions may cut at the wrong point. | Connect at appropriate outgoing/incoming boundaries. | Before/after boundary replay, including same-source adjacent units and upper-body replacement. |
| Normal and Lively look too similar; Normal is distracting. | Lively approximates the old Normal; Normal is visibly quieter. | Matched scenario comparison and mid-playback changes; retain contact and hand readability. |
| Hands in front of the torso should be higher. | Readable conversational hand position. | Identify the exact clip/phase and compare original versus composed hand height. A standing snapshot cannot close this item. |
| Hand-on-hip happens too often. | Occasional posture rather than a recurring default. | Eligible-time frequency and occupancy across several minutes; check both scheduled posture and ambient selection. |
| Head generally appears tilted upward; camera may contribute. | Natural head/gaze presentation in the work view. | Compare the same pose under a fixed front/side camera, then the actual tracked camera. Record head/neck rotation and camera parameters independently. |
| Torso moves but arms do not follow; the whole body feels disjointed. | Coordinated torso, shoulders, arms, pelvis and support through the whole act. | Synchronized source/target/composed replay, including layer ownership changes and recovery. |
| Arms penetrate the body, but pushing them too far out would also look wrong. | Natural avatar-specific clearance and intentional contact. | Continuous clothed-mesh front/side review through complete acts and blends, checking both penetration and unnatural separation. |

## Related implementation decisions

- [Recorded body playback](recorded-body-playback.md) and [idle dynamics](recorded-idle-dynamics.md)
- [Motion orchestration](motion-orchestration.md) and [conversation strength](conversation-performance-gain-review.md)
- [Motion intensity](motion-intensity.md)
- [Final composed-pose diagnostics](composed-motion-diagnostics.md)
- [Frame budget and GC](runtime-frame-budget.md)

Primary-source research and the full rationale are preserved in internal
design-record: `2026-09-19-whole-body-motion-quality-research.md`. Public technical
foundations include [Motion Graphs](https://research.cs.wisc.edu/graphics/Papers/Gleicher/Mocap/mograph.pdf),
[Ubisoft's motion-matching explanation](https://www.ubisoft.com/en-us/studio/laforge/news/6xXL85Q3bF2vEj76xmnmIu/introducing-learned-motion-matching),
and [Epic's runtime inspection workflow](https://dev.epicgames.com/documentation/en-us/unreal-engine/motion-matching-debugging-in-unreal-engine).
These support the method; they do not validate the current avatar's settings or
establish visual acceptance.

## Revision history

- 2026-09-19: Established the recurring review profile and evidence record from live user feedback.
