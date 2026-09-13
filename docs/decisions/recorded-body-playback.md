# Recorded body playback and user review fixes

This work addresses the user's 2026-09-14 review: a dropped shoulder held for 8–10 seconds, folded wrists, an inactive lower body, jerky motion, and straight default fingers. The user accepts asymmetric shoulders when they accompany coherent weight transfer. Symmetrizing all performances or increasing procedural sway would not meet that request.

## Runtime

A reviewed body unit keeps the source pelvis translation, both legs, torso, arms and fingers on one source clock. The player creates two synchronized mixer actions for that same recording. A speech gesture takes over the upper contribution through complementary weights while the supporting legs continue. The upper and lower recordings do not run on independent random clocks. Lower-body weight remains one during ordinary playback; reducing the entire leg pose toward a reference would move planted feet.

Units finish at an annotated support interval. The player holds the end only until the next compatible unit can begin; it does not automatically fade the hips back to their reference position. The incoming unit is aligned by a constant pelvis XZ offset. Its feet and toes, height, support speed, and every sampled pose during the fade must pass the contact gate. Gate rejection leaves the previous supported pose intact. The admitted unit graph must therefore include an accepted successor for every unit, including self-transitions. A successful file load is insufficient admission.

The bundle admits two idle units from the reviewed Looking Around recording (7.0833–15.6667 and 15.6667–23.3667 seconds). Compatible alternatives are preferred to immediate repetition. The later pointing performance is excluded from ordinary idle even though its foot contacts pass. Each admitted unit has a compatible successor. The first unit carries approximately 79 mm of lateral pelvis travel; the second approximately 36 mm. These are standing weight transfers, not steps.

If the next conversation activity has no compatible stance, the sequencer tries a compatible repetition of the current recorded body unit. Its arms are suppressed while the new activity's upper performance takes over. In this bundle, speech uses the continuing Looking Around legs with a Chatting upper performance; it does not play Chatting's source pelvis trajectory. This preserves a recorded weight shift instead of leaving the lower body frozen during a long explanation. Listening, thinking and interruptions also release the base's scanning upper body without cutting a leg in mid-movement.

The reviewed source stance is established before the model enters the rendered scene. The player permits this initial placement only before its clock has advanced and while no other action owns it. It cannot be used to snap a displayed avatar's feet to a new stance. Normal transitions still pass the contact gate.

Contact preparation is specific to the exact Yori model, including the shoes. ThreeRuntime hashes the loaded model bytes; the optional body bundle is accepted only when its target hash matches. Missing assets and other avatars retain the generic recorded library. `state_get.recordedBody` reports the admitted unit count, current source, phase, held state and upper-body ownership separately from the gesture scheduler.

The target preparation bounds are documented in [recorded-target-contact-adaptation.md](recorded-target-contact-adaptation.md); contact correction changes part of the pelvis height trajectory. [recorded-body-bundle.json](recorded-body-bundle.json) pins the reviewed model and animation hashes. After faithful conversion and target adaptation, run `node scripts/install-recorded-body.mjs` then `npm run fetch-assets`. Installation preserves the source originals and writes the admission manifest after its files. The motion lab computes the same model hash and initializes the same Body sequencer as the native runtime.

## Other corrections

- The quiet `Idle` upper-body loop carried a fixed shoulder inclination of approximately 13 degrees. Rest-relative calibration of the complete upper chain removes this fixed bias while retaining recorded local rotation changes. Intentional asymmetry in other recordings is preserved. See [quiet-idle-calibration-metrics.json](quiet-idle-calibration-metrics.json).
- `Idle Conversation` is excluded from automatic selection after direct source-FBX and converted-clip wrist inspection reproduced the same folded hand. `Idle Chatting` and `Idle Chatting 2` retain their recorded hand shapes. Their reviewed 30 Hz conversions are installed beside the original external assets and overlaid only when their hashes match.
- Relaxed fingers now bend toward the palm instead of twisting around their long axes. Authored open palms remain authoritative.
- The native render limiter retains deadline remainder and uses the RAF timestamp. Recorded motion, including a lower-body-only contribution, requests 60 fps; ordinary quiet fallback remains 30 fps. This fixes a cadence defect rather than slowing or smoothing away the source acting.
- Generated TypeDoc pages and private motion captures are excluded from Vite's development watcher. Repeated post-commit page reloads had made the native review unstable. The user-facing review server additionally disables HMR while changes are being evaluated.

## Practical limits

Support annotations are geometric candidates inferred from source feet and toes, then inspected on the target. They are not ground-truth labels. Watching contains cumulative source foot drift and is not admitted as a long planted full-body recording merely because its foot speed is low. A target correction's distance or joint angle alone is not a perceptual quality score.

The current full-body transition gate supports compatible standing stances, not arbitrary locomotion or dance joins. It rejects different foot placements instead of sliding them together. Moving-base semantic entry scoring uses the base pose but omits the previous static-reference velocity term; full velocity-aware layered prediction remains future work. Explicit manual takeover and reduced-motion changes take precedence and can still fade the body to its reference; their contact behavior is distinct from reviewed automatic unit transitions.

The comparison target remains Animates' naturalness and contribution to presence. The new runtime, source fidelity metrics and passing tests do not establish superiority. Music detection, BPM alignment and dance are not implemented by this change. Final evaluation must include the actual native application with visible feet and hands, listening and speech boundaries, sustained idle, and the user's comparative review.
