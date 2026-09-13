# Recorded motion orchestration

Status: implemented on `feat/motion-orchestration`; comparative human evaluation pending.

Yorishiro now uses recorded VRMA motion as the main idle and conversational body performance. Procedural breathing, gaze and small offsets supplement the recording. Previously those offsets overwrote the spine and arm rotations even when a recorded clip had most of the weight; that mixing error is fixed.

## Runtime

`Body` warms ten local recordings from the existing asset store. `MotionDirector` queries an inspectable six-dimensional semantic index (calmness, attention, reflection, affiliation, emphasis, movement energy), filters context and cooldown, and samples at most five eligible candidates. This is a small local vector search, not a language-model embedding or an external vector database. No paid API, local model download or extra inference is needed. Existing assistant transcript interpretation supplies speech intent; optional inline text tags are unnecessary. The shared `VoicePlayer.say(text)` path also passes text through the same local resolver, so MCP speech, Quick Chat and persona speech using the existing OS `SayTtsEngine` can drive motion without a realtime API. Cues remain pending during synthesis and acquire ownership only after Web Audio starts. Stop, cancellation and playback-owner changes release them; the unclocked native fallback does not pretend to provide gesture timing.

Idle motifs normally last 12–25 seconds with occasional extra quiet time. Immediate repetition is excluded; recent clips and motion families are penalized. Listening narrows the eligible pool to quiet attentive recordings. Thinking, speaking, interruption, ownership and reduced motion each have explicit behavior. A voice utterance owns its gesture; a nearby facial cue does not restart or truncate it when gesture selection is temporarily suppressed. After speech, the recorded idle can resume after 2.5 seconds of settling.

`AnimationPlayer` retargets and analyzes quaternion poses and angular velocities once per clip variant, with bounded sampling. Continuous motions search a short outgoing low-speed window and a compatible incoming phase. Authored gestures retain their beginning. Incoming and outgoing weights follow smoothstep ramps without changing playback speed to fit unrelated clip lengths. Asynchronous loading and delayed entry remain conditional on current ownership. Old fades are retired when an external animation owner takes over.

Looping recordings receive a cached tail correction. The final 0.4–0.8 seconds converge to the first pose and its angular velocity using a quintic envelope. Original non-looping performances stay intact. This closes the internal loop seam as well as the seam between different clips. It is a bounded alteration of the end of a looping recording, not generated motion or an IK solver.

## Contact and scope

The automatic library uses an upper-body bone mask. Hips, legs, feet and toes remain at the standing base, while the recorded torso, arms, head and fingers contribute. Whole-character breathing displacement is attenuated by recorded weight. Explicit full-body motions remain available through the original API.

This restriction is deliberate: the [29-asset audit](motion-assets-analysis.json) found that removing hip translation from several existing recordings changes foot motion substantially. Low-speed frames can still differ in foot placement by tens of centimetres. The current feature therefore does **not** claim full-body contact-aware motion matching, foot locking, locomotion or support for arbitrary unreviewed recordings. Full-body expansion needs calibrated root motion and contact constraints; upper-body masking is not a substitute for that work.

The default library is five idle recordings and five conversational recordings. Selection, phase matching and loop correction are separate operations; semantic candidate ranking does not yet include the cross-clip transition cost. The source assets remain in `../Yorishiro-assets`, following existing distribution and licensing rules.

## Use and verification

Run from the worktree:

```sh
npm run motion:lab
npm run motion:audit
npm run motion:seams
```

The lab is at `http://127.0.0.1:1437/motion-lab.html`. It compares the same Yori avatar, camera and lighting with the library disabled/enabled and lets a reviewer exercise semantic gestures. It is a development entry point, not part of the release bundle. “Export observations” saves selected clips, timing and sampled head/hand positions. `scripts/capture-motion-lab.mjs` can automate screenshots and, with `--film`, a 30-second comparison video using a separately available Playwright/browser and ffmpeg. `YORISHIRO_PLAYWRIGHT_MODULE`, `YORISHIRO_CHROME_PATH`, `YORISHIRO_MOTION_LAB_URL` and `YORISHIRO_MOTION_QA_DIR` configure those local tools and outputs. The default output is the Git-ignored `.motion-review/` directory.

`motionIntensity` scales automatic clip strength; zero releases automatic motion. `Body.setMotionLibraryEnabled(false)` allows a controlled baseline or an internal opt-out without cancelling a persona/MCP-owned performance. Advanced callers can set `MotionOptions.mask`, `transition` and `maxTransitionDelayMs` through the existing motion slot API. Semantic requests are currently an internal Body API.

Tests cover retrieval/diversity, real-mixer fade envelopes, phase selection, loop position/velocity continuity, ownership races, same-clip replay, claims, missing assets, conversational boundaries and reduced motion. The asset audit additionally checks its FK against the official retargeted Three.js mixer. The [loop metrics](motion-loop-seam-metrics.json) quantify improvement over the original source clip at its boundary; they are not measurements of Animates or human preference.

## Acceptance

Implementation and regression checks are distinct from the requested acceptance criterion. A comparison against installed Animates is still required to establish a clear advantage in naturalness and presence. Follow the [evaluation protocol and observed Animates conditions](motion-orchestration-evaluation.md). More motion variety or a lower boundary discontinuity alone does not establish that advantage.

## Verification record, 2026-09-13

The final production implementation, including the local OS speech bridge, passed 2,971 tests across 237 frontend test files, TypeScript checking, Biome checks on changed sources, TypeDoc generation, and the production build. The speech checks cover actual Web Audio start notifications through the OS synthesis adapter, overlapping requests, cancellation, playback-owner changes and the unclocked fallback. The build retains a large-chunk warning. Browser QA exercised 185 simulated seconds without page errors and rendered a 30-second, 720-frame comparison film. The film driver checks that animation time equals video time; its 24 Hz capture steps preserve partial 60 Hz simulation steps rather than speeding up playback. Runtime facial expression, hair and other VRM updates run once per frame.
