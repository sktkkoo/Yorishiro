# Recorded motion orchestration

Status: implemented on `feat/motion-orchestration`; comparative human evaluation pending.

The [quality strategy](motion-quality-strategy.md) sets the current priority: restore faithful full-body/finger replay from the original recordings, then review Idle, listening, conversation and their handoffs. Animates' music-synchronized dancing is a quality reference, not the first required feature. Current runtime improvements are foundations, not proof that the material or product meets that reference.

Yorishiro now uses recorded VRMA motion as the main idle and conversational body performance. Procedural breathing, gaze and small offsets supplement the recording. Previously those offsets overwrote the spine and arm rotations even when a recorded clip had most of the weight; that mixing error is fixed.

## Runtime

`Body` warms nine local recordings from the existing asset store. `MotionDirector` queries an inspectable six-dimensional semantic index (calmness, attention, reflection, affiliation, emphasis, movement energy), filters context and cooldown, and samples at most five eligible candidates. This is a small local vector search, not a language-model embedding or an external vector database. No paid API, local model download or extra inference is needed. Existing assistant transcript interpretation supplies speech intent; optional inline text tags are unnecessary. The shared `VoicePlayer.say(text)` path also passes text through the same local resolver, so MCP speech, Quick Chat and persona speech using the existing OS `SayTtsEngine` can drive motion without a realtime API. Cues remain pending during synthesis and acquire ownership only after Web Audio starts. Stop, cancellation and playback-owner changes release them; the unclocked native fallback does not pretend to provide gesture timing.

Idle motifs normally last 12–25 seconds with occasional extra quiet time. Immediate repetition is excluded; recent clips and motion families are penalized. Listening narrows the eligible pool to quiet attentive recordings. Thinking, speaking, interruption, ownership and reduced motion each have explicit behavior. A voice utterance owns its gesture; a nearby facial cue does not restart or truncate it when gesture selection is temporarily suppressed. After speech, the recorded idle can resume after 2.5 seconds of settling.

Neutral speech also has a recorded performance. Actual audio start selects a restrained explanatory background from three conversational recordings, with 10–18 second dwell times. This does not require an emotional keyword. Facial-cue expiry releases only the face; finite body gestures use their authored end, or a low-velocity exit 6–6.5 seconds after entry for longer recordings, followed by their fade. Audio completion and interruption still release speech ownership. Once conversation phases are supplied, they take precedence over a lip-sync analyser that stays active for an entire realtime connection; listening and silent idle therefore resume while the connection remains open.

`AnimationPlayer` retargets and analyzes quaternion poses and angular velocities once per clip variant, with bounded sampling. Continuous motions search a short outgoing low-speed window and a compatible incoming phase. Authored gestures retain their beginning. Incoming and outgoing weights follow smoothstep ramps without changing playback speed to fit unrelated clip lengths. Asynchronous loading and delayed entry remain conditional on current ownership. Old fades are retired when an external animation owner takes over.

Looping recordings receive a cached tail correction. The final 0.4–0.8 seconds converge to the first pose and its angular velocity using a quintic envelope. Original non-looping performances stay intact. This closes the internal loop seam as well as the seam between different clips. It is a bounded alteration of the end of a looping recording, not generated motion or an IK solver.

## Contact and scope

Automatic performances use an upper-body bone mask over an independent recorded standing foundation. The reviewed `Idle` clip supplies hips, legs, ankles and toes continuously, while the selected recordings supply torso, arms, head and fingers. Replacing an upper-body performance does not restart the lower-body cycle. Explicit full-body performances and animation claims take precedence over the foundation. Whole-character breathing displacement is attenuated by recorded weight on either layer.

The standing foundation first transfers Idle's small recorded rotation changes relative to its first frame onto the target's normalized rest pose. This avoids a 10–16 cm foot displacement caused by blending directly into the source's different initial stance. After loop conditioning, target-skeleton forward kinematics recovers the shared displacement of both ankles and toes and adds the inverse to the hips position. It does not use the source translation scale: the converter's zero rest hip height makes that scale invalid. This preparation runs once on private transform copies, without posing the live avatar.

This restriction is deliberate: the [29-asset audit](motion-assets-analysis.json) found that removing hip translation from several existing recordings changes foot motion substantially. Low-speed frames can still differ in foot placement by tens of centimetres. Foundation calibration and grounding apply only to the reviewed quiet Idle, whose lower-body changes stay within about 1.12 degrees. They do **not** provide arbitrary full-body contact-aware motion matching, foot IK, locomotion, floor collision or contact inference. Handoffs from an arbitrary explicit leg stance can still move the feet; those require separate transition/contact work.

The default library is five idle recordings and four conversational recordings. Selection, phase matching and loop correction are separate operations; semantic candidate ranking does not yet include the cross-clip transition cost. The source assets remain in `../Yorishiro-assets`, following existing distribution and licensing rules.

The [standing measurements](standing-idle-grounding-metrics.json) replay the real mixer at 120 Hz on Yori, including SDK-updated raw bones. Across two loops the calibrated, grounded foundation's maximum foot drift is 0 / 0.259 / 0.645 / 1.286 mm at weights 0 / 0.2 / 0.5 / 1. The 1.2-second start fade stays within 1.286 mm, compared with 161.302 mm for an uncalibrated absolute-pose fade; fading out and reducing gain from 1 to 0.2 stay within 0.299 / 0.328 mm respectively. These tests use phase-zero starts and no procedural layers; they establish the reviewed foundation's behavior, not universal foot locking or human preference.

## Use and verification

Run from the worktree:

```sh
npm run motion:lab
npm run motion:audit
npm run motion:seams
npm run motion:grounding
```

The lab is at `http://127.0.0.1:1437/motion-lab.html`. It compares the same Yori avatar, camera and lighting with the library disabled/enabled and lets a reviewer exercise semantic gestures. It is a development entry point, not part of the release bundle. “Export observations” saves selected clips, timing and sampled head/hand positions. `scripts/capture-motion-lab.mjs` can automate screenshots and, with `--film`, a 30-second comparison video using a separately available Playwright/browser and ffmpeg. `YORISHIRO_PLAYWRIGHT_MODULE`, `YORISHIRO_CHROME_PATH`, `YORISHIRO_MOTION_LAB_URL` and `YORISHIRO_MOTION_QA_DIR` configure those local tools and outputs. The default output is the Git-ignored `.motion-review/` directory.

`motionIntensity` scales automatic clip strength; zero releases automatic motion. `Body.setMotionLibraryEnabled(false)` allows a controlled baseline or an internal opt-out without cancelling a persona/MCP-owned performance. Advanced callers can set `MotionOptions.mask`, `transition` and `maxTransitionDelayMs` through the existing motion slot API. Semantic requests are currently an internal Body API.

Tests cover retrieval/diversity, real-mixer fade envelopes, phase selection, loop position/velocity continuity, ownership races, same-clip replay, claims, missing assets, conversational boundaries and reduced motion. The asset audit additionally checks its FK against the official retargeted Three.js mixer. The [loop metrics](motion-loop-seam-metrics.json) quantify improvement over the original source clip at its boundary; they are not measurements of Animates or human preference.

## Acceptance

Implementation and regression checks are distinct from the requested acceptance criterion. A comparison against installed Animates is still required to establish a clear advantage in naturalness and presence. Follow the [evaluation protocol and observed Animates conditions](motion-orchestration-evaluation.md). More motion variety or a lower boundary discontinuity alone does not establish that advantage.

## Verification record, 2026-09-14

The current implementation, including the local OS speech bridge, recorded standing foundation and prototype exclusion, passed 3,004 tests across 239 frontend test files, TypeScript checking, Biome checks on changed sources, TypeDoc generation, and the production build. The speech checks cover actual Web Audio start notifications through the OS synthesis adapter, overlapping requests, cancellation, playback-owner changes and the unclocked fallback. The build retains a large-chunk warning. Browser QA exercised 232 simulated seconds through idle, gestures, a 45-second neutral explanation, and listening without page errors and rendered a 30-second, 720-frame comparison film. The film driver checks that animation time equals video time; its 24 Hz capture steps preserve partial 60 Hz simulation steps rather than speeding up playback. Runtime facial expression, hair and other VRM updates run once per frame.

The 232-second browser run also sampled normalized foot markers with all Body layers active. From 3 seconds onward, the largest distance from the first sampled foot position was 1.496 mm for the recorded system and 12.286 mm for the procedural baseline. These are marker-motion diagnostics, not mesh-floor contact or perceptual scores. That film predates the final removal of the unreviewed emphasis prototype; use the current lab for the nine-clip catalog.
