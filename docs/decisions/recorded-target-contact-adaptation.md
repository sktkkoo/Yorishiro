# Target support for recorded body units

This preparation keeps an authored full-body recording and adapts its support to the exact Yori skeleton and shoes. It does not replace the pelvis trajectory with a periodic sway, freeze both legs, or change the recorded arms and fingers. It supports the runtime described in [recorded-body-playback.md](recorded-body-playback.md); passing this preparation alone does not admit a runtime transition or establish superiority over Animates.

## Reproduction and scope

Run after the source-faithful library preparation and [source contact analysis](recorded-contact-candidates.md). Inputs are the hash-verified 30 Hz conversions listed in [source-faithful-library-metrics.json](source-faithful-library-metrics.json), not the older 12.5 Hz conversions. Times are relative to the prepared clip, whose source FBX in-point is 0.1 seconds.

```sh
node scripts/adapt-recorded-contacts.mjs docs/decisions/recorded-contact-candidates.json 'Idle Chatting' 'Idle Chatting 2'
node scripts/adapt-recorded-contacts.mjs docs/decisions/recorded-contact-candidates.json 'Idle Looking Around' --reviewed-unit around-idle
```

Generated VRMAs remain in the ignored `.motion-review/source-assets/prepared/` directory. Each ends in `.yori-contact.vrma`. Each invocation also writes its full measurements to `.motion-review/recorded-contact-adaptation-results.json`; subsequent invocations replace that report. [recorded-target-contact-metrics.json](recorded-target-contact-metrics.json) retains the compact results and exact output hashes. No original FBX, source VRMA, avatar, or private capture is committed. The tool refuses missing or mismatched source hashes, a different target model, unknown clip selections, and overwriting a source or target file. A failed run leaves existing files alone; consumers must check its accepted result and exact output hash, not infer approval from a filename.

`--reviewed-unit around-idle` is an explicit exception for the exact reviewed Around source and target hashes. It permits only these finite playback windows:

| Unit | Start | End |
| --- | ---: | ---: |
| Early | 7.08333333 s | 15.66666667 s |
| Middle | 15.66666667 s | 23.36666667 s |

The file retains its full source duration and time coordinates. Its metadata lists the allowed windows; the runtime manifest must enforce those limits. There is no approved whole-clip loop. Generic quaternion loop closure must not be applied to this full-body asset. `--diagnostic` can write a separate `.diagnostic.vrma` for inspection after an initial budget failure; that flag grants no automatic playback approval.

## What the preparation changes

Source speed and height intervals are geometric contact candidates, not authored labels or semantic boundaries. The adapter accepts a side's episode only when it lasts at least two seconds and the original source ankle and toe each travel no more than 15 mm horizontally from their episode start. Missing displacement evidence fails closed. Short steps and ambiguous episodes keep their recorded leg rotations.

For each eligible episode, the target ankle/toe midpoint provides a horizontal anchor. Actual skinned shoe vertices provide the target floor measurement. A 350 ms quintic ramp enters and leaves the correction. The common pelvis offset follows the support error; each supported leg then uses a two-bone solve with its recorded knee pole. Foot world orientation remains authored, so toe/heel rocking is preserved. An unsupported leg keeps all three local leg rotations, while its world trajectory can follow the bounded common pelvis offset.

A small additional pelvis projection prevents an otherwise unreachable leg target. Source hips XYZ remain the input trajectory. The correction is separate from that trajectory, and the report separates mean offset from time-varying correction. The normalized source/target hip-height relation and the official loader determine translation conversion; no guessed source unit scale is used. Upper-body and finger key times and values remain exactly unchanged. Only hips translation and six leg rotation tracks are rebaked at 60 Hz.

Initial review budgets are 30 mm common pelvis correction, 15 mm independent ankle correction, 10 mm extra pelvis reach projection, and 8 degrees of local leg rotation change. Around exceeds the last budget because Yori's limb proportions differ from the source. The reviewed, hash-locked policy explicitly permits 13.1 degrees; it does not silently raise the default. Whole-clip maxima are 17.28 mm pelvis correction, 4.81 mm reach projection and 12.95 degrees of leg rotation difference. The maximum angle occurs near 26.8 seconds in the excluded late candidate. In the middle unit, maximum pelvis correction is 9.71 mm and the largest leg difference is 11.22 degrees. A source-knee-distance-preserving experiment instead required about 72 mm of extra pelvis movement and was not selected.

The middle unit retains about 35.89 mm of lateral and 20.83 mm of fore/aft pelvis movement, with source correlations 0.99987 and 0.99379. Its small vertical range decreases from 4.94 to 2.76 mm, with correlation 0.351; this is a material limitation of the contact adaptation, not exact XYZ preservation. Its nearly straight source-target left knee changes from about 2.277 degrees to 0.849 degrees. The right knee changes from 7.99–12.61 to 17.21–21.99 degrees. These measurements motivated actual target visual review rather than accepting or rejecting the asset from the angular difference alone.

## Validation and review evidence

The separate verification pass reloads the generated VRMA through the official loader at 120 Hz, including points between bake keys. It checks finite values, actual shoe clearance and penetration, horizontal ankle/toe-center error, preserved foot orientation, unchanged unsupported leg rotations, knee pole continuity and unchanged upper/finger tracks. Around's maximum supported shoe error is 0.262 mm and contact-center error is 0.016 mm. Chatting's corresponding errors are 0.029 mm and 0.021 mm. These are preparation measurements, not claims about arbitrary runtime blending.

Chatting preserves the source heel raise around 16.5–17 seconds: the left ankle rises 28.15 mm in the direct target replay and 28.09 mm after adaptation; toe rises are 7.02 and 6.96 mm. Private front/oblique samples at 4.3667, 8, 11.35, 17, 18 and 19 seconds showed no new knee inversion, broken leg or hand/torso collision. Replaying the final output matched all 108 saved target joint positions in `.motion-review/chatting-contact-qa/observations.json` exactly. An early experimental hash changed when sub-two-second contact locks were removed; that change preceded these final visual samples.

Around's private source/target comparison is in `.motion-review/around-contact-qa/`. Front and oblique samples at 5, 8, 15.6667, 19, 23.3667, 28 and 31.7667 seconds showed no new knee inversion, broken leg or obvious crouch. The upper-body look-around and weight transfer remain visible. Clothing hides part of the knee contour, and sparse screenshots do not alone establish smooth timing. A continuous 24 fps comparison of the middle unit is retained as `comparison-15.67-23.37.mp4`. Additional private 24 fps early/late comparisons are retained in `.motion-review/around-units-qa/` (206 and 186 frames). Their start/middle/end and selected intermediate images showed no new leg inversion or break; the late candidate's raised pointing hand was plainly visible in both source and adapted lanes. Continuous whole-duration human viewing remains outstanding. The diagnostic artifact used for that review and the final asset have exactly equal animation key times and values; only preparation metadata differs.

The actual player's 800 ms gate accepted all nine directed joins, including self-joins, between the early, middle and late Around candidates. Physical compatibility did not establish semantic suitability: the late candidate (23.3667–31.1167 seconds) visibly points upward around 24.62 seconds, so it is excluded from spontaneous idle. Only the early and middle units are whitelisted. Its measured maximum fade foot error was 1.939 mm and minimum shoe height was −0.338 mm. That separate check also found Around and Chatting stances incompatible. The normal conversation path can therefore continue the recorded Around lower body while taking over its upper performance; this work does not claim an accepted Around-to-Chatting full-body handoff. A fresh model can start in the reviewed stance before its first visible frame; visibly fading from the narrow default stance would slide the feet and is not an accepted substitute.

Chatting 2 passes offline numerical support checks and remains a next candidate; this does not approve its joins to the current standing graph. Watching is rejected for automatic planted full-body use: its source itself drifts roughly 44–68 mm over long, slow episodes. Low instantaneous speed did not make those episodes stationary contacts. With the displacement check, no eligible double-support window remains. Around 2 is not admitted by this policy; later partial-support reach corrections need separate unit and visual review.

The original Animates comparison criterion remains unverified. This report establishes source preservation, bounded target support and a limited set of measured transitions, with target images available for human review. It does not establish that every gesture or every avatar is natural, nor that the resulting product is superior to Animates.
