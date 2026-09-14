# User-provided Mixamo motion imports

Recorded 2026-09-15. **Seven original FBX files have been converted and passed source-fidelity validation. Actual Yori acting, composition, and automatic admission are separate decisions in the [motion review](mixamo-motion-review.json).**

| Received original | Full converted duration | Original 30 Hz frames |
| --- | --- | --- |
| `Warrior Idle.fbx` | 13.3 s | 400 |
| `Sad Idle.fbx` | 2.8 s | 85 |
| `Fist Pump.fbx` | 3.8 s | 115 |
| `Thoughtful Head Shake.fbx` | 3.0667 s | 93 |
| `Shrugging.fbx` | 2 s | 61 |
| `Hands Forward Gesture.fbx` | 3.1 s | 94 |
| `Texting While Standing.fbx` | 23.5667 s | 708 |

The user identifies all seven as Adobe Mixamo downloads and authorized conversion and review for idle or conversational use. Earlier exact-file access/move attempts for Sad/Warrior in Downloads returned macOS `PermissionError: Operation not permitted`. The user subsequently moved all seven files to `../Yorishiro-assets/sources/`; the converter read them there without modifying or moving them. No alternate Downloads access route was used. Individual animation page identifiers and pre-export capture settings were not independently recorded.

The [conversion report](mixamo-source-conversion.json) pins all seven source and VRMA SHA-256 values and records per-file validation. Reproduce with `node scripts/prepare-mixamo-import.mjs`. Outputs remain private under `.motion-review/mixamo-import-20260915/`; no FBX or VRMA is committed to Git. The explicit `mixamo` profile retains the complete original clock from zero, including every exported 30 Hz key, 52 bone rotations (30 finger bones), and hips XYZ variation. It removes only one constant initial hips XZ origin. It performs no smoothing, speed change, semantic trimming, masking, loop conditioning, or foot-contact correction. Single-key source poses are retained as constant poses: Sad has 17 constant rotation tracks and Shrugging has 32, so their presence does not imply newly recorded finger animation.

Original FBX replay versus official VRMA replay on the same source skeleton was compared at all keys and midpoints. Across all seven, maximum key errors were below `1.70e-7 m` world position and `1.43e-5 degrees` world rotation, with zero non-finite source/output values. These are conversion-fidelity measurements, not target foot-sliding or perceptual-quality scores. One existing Rokoko Conversation was privately regenerated with the unchanged default profile; its SHA remained exactly `0376d3e416975f7d25aadd817828b77cf53a2f84ec5bc3cc3053fe1bc631dcf1`. No existing asset was overwritten.

The user's initial requested contexts were a brief, infrequent sad pose for Sad Idle and an infrequent stretch for Warrior Idle. Those uses require review of the actual performance and compatibility with the continuing lower-body recording. The full Warrior recording is retained; the separate [Warrior stretch derivation](warrior-stretch-derivation.json) records an exact-key 5–10 second candidate, without granting automatic admission. Neither filename alone establishes contextual suitability.

## Official license sources checked

Adobe's [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html), checked 2026-09-15 (page marked updated 2021-09-14), states that Mixamo is free with an Adobe ID without a Creative Cloud subscription, and permits royalty-free personal, commercial, and nonprofit uses of its characters and animations. This supports use within a project; it is not a grant of an open-source license to the animation files.

Adobe's [General Terms of Use](https://www.adobe.com/legal/terms.html), checked 2026-09-15 (published/effective 2025-10-03), distinguish software/service rights from content-file rights. Section 3.6 permits modification and distribution of Content Files as part of an end-use product, while excluding standalone distribution. Section 1.2 gives applicable product-specific terms precedence. Keep the original FBX and converted VRMA outside public Git and retain this source record when embedding an approved result in Yorishiro. This summary does not replace the applicable Adobe terms.

The FAQ and cited content-file provision do not state a mandatory attribution line. Yorishiro records Adobe Mixamo in `CREDITS.md` for provenance; it does not claim attribution is required, that the assets are MIT-licensed, or that Adobe endorses Yorishiro. No file-specific license sidecar or download-page terms were supplied as part of this seven-FBX conversion record.
