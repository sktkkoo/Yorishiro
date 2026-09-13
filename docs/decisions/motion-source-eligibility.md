# Motion source eligibility and performance review

Status: source audit, 2026-09-14. The automatic catalog retains nine documented source assets. Source provenance and passing runtime tests do not establish perceptual quality or superiority to Animates.

## Source records

The repository's [CREDITS.md](../../CREDITS.md#vrma-animations) is the existing asset-to-provider record. Absence of a README in the external asset directory does not mean all assets lack provenance. The current GLB metadata generally identifies the converter, not the original performer or license.

| Assets | Documented source and intended use | Eligibility judgment |
| --- | --- | --- |
| `Idle` | Mixamo, converted to VRMA. Quiet standing recording. | Retain as the reviewed standing foundation under its documented calibration constraints. This is not a reusable arbitrary full-body contact solver. |
| `Idle Conversation`, `Idle Chatting`, `Idle Chatting 2` | Rokoko everyday idle mocap pack. Sustained conversational performances. | Retain as conversational candidates. Validate the complete performance and its retargeting before treating any subphrase as agreement, reassurance, or emphasis. |
| `Idle Looking Around`, `Idle Looking Around 2` | Same Rokoko pack. Includes substantial whole-body reorientation. | Retained compatibility candidates, not accepted as universally quiet idle. Review coherent intervals and restore the original body/root relationship before extending full-body use. They are excluded from listening selection. |
| `Idle Watching Something` | Same Rokoko pack. Observation/attention recording with posture changes. | Retain as an attentive candidate, subject to checking gaze direction, body support and its complete transitions. A low-speed interval alone is not acceptance. |
| `VRMA_06_HandOnHip` | VRoid Project's official `VRMA_06`, described as “Model pose.” | Treat as a deliberate pose change, not evidence of conversational listening or a naturally idle body. Review hand-to-hip contact and weight transfer before expanding its automatic use. |
| `Thankful` | Mixamo, converted to VRMA. A short authored performance. | Keep as a candidate requiring semantic review. The current agreement/reassurance mapping is a heuristic; a file name or motion alias does not establish that the performance fits either speech act. |
| `Conversational Emphasis Planted Prototype` | GLB generator: `Yorishiro planted-conversation prototype generator`. No corresponding source mapping was found in CREDITS or the local source manifest. | Removed from the automatic catalog. Explicit animation playback remains available for diagnostics. Do not count this as a validated production capture. |

The [Rokoko source page](https://www.rokoko.com/resources/rokoko-mocap-10-free-everyday-idle-animations) describes full-body and finger motion capture, supplied as FBX on a Mixamo skeleton at 30 FPS. The [VRoid source page](https://booth.pm/ja/items/5512385) identifies the model-pose action and supplies its attribution and usage conditions. [Adobe's Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) confirms the free animation service and project-use scope. Provider terms remain distinct from converter code licenses; retain the asset-specific source and terms records.

The separate external `mocap-prototype/sources/manifest.json` records Pexels extraction experiments. Its entries explicitly describe diagnostics, not production animations, and one says no linguistic meaning is inferred. It is not the provenance record for the Rokoko recordings. No link between those experiments and the planted prototype is established by the available records.

## Recover source quality before replacing it

The existing audit shows that most converter-produced files have a flat source skeleton with zero rest hip height; several Rokoko clips contain no translation track. The runtime's upper-body selection over an independent quiet standing foundation then omits the original capture's pelvis/leg coordination. It can prevent one class of foot displacement while also losing part of the actor's performance. Those are pipeline limitations, not proof that the original capture is poor.

Compare three stages on the same target character: original FBX retargeting, converted VRMA, and final runtime composition. Preserve the original recording, source skeleton/rest pose, units, root trajectories, finger tracks, conversion settings and file hashes. Locate the first stage that loses a wrist shape, shoulder response, weight shift or foot contact before applying cleanup. If the original performance is poor, reject that interval rather than attempting to certify it through smoothing.

A read-only search found no original Rokoko FBX in the accessible asset locations. The FBX files found under `mocap-prototype/results` are extraction outputs. Access to `Documents/VRMAConverter` was unavailable, so this is not proof that the originals do not exist locally. The official source page currently links [the original everyday-idle archive](https://media.rokoko.com/EVERYDAY-IDLES-MOCAP.zip), which provides a concrete recovery path without selecting a new paid service.

## Screening each authored interval

Review the source and target at normal speed with visible hands and feet, then use frame inspection to locate defects. Acceptance is per interval, target rig, intended activity and allowed transition, not per attractive file name.

- **Hands and body coordination:** preserve meaningful wrist orientation, fingers, elbow paths, shoulder response and torso/pelvis timing. Reject unresolved snapping, inversion, hand/body penetration, lost contact or disconnected arm motion. A finger track's existence does not prove a usable hand performance.
- **Standing and support:** distinguish an intended step from a planted foot. Check the mesh and support during entry, the complete performance, exit, fades and changes of weight. Reject a planted foot that visibly drifts, an unsupported lean, or a stance change hidden by the camera. Do not count a numerically fixed lower body as proof that the upper body remains coherent.
- **Authored phrase:** retain preparation, main action and recovery. A low-velocity frame may be the held peak of a gesture, not its end. The current 6–6.5 second cap is a runtime guard; it does not certify a semantically valid exit. Annotate valid recovery/exit intervals from the actual performance.
- **Speech alignment:** start only with real audio ownership. Check whether the main action fits the spoken phrase and emphasis, including neutral explanations and silent pauses. Facial-cue expiry must not cut the body performance; interruption must release it. Matching text to a generic conversational clip is not word-level gesture synchronization.
- **Idle:** judge sustained stillness, attention and purposeful changes over an unedited wait. Reject contextually distracting scanning, repeated model poses or constant conversational hand movements during silence.
- **Dance:** use a reviewed full-body performance with its original support changes, root motion and musical phrasing. Check beat/phrase timing, starts, stops and recovery to conversation. `Idle Listening To Music` is not automatically a dance asset, and the current automatic catalog has no dance activity or music-phase controller.

Measured seams, foot trajectories, timing and ownership failures help locate defects. They do not provide a universal numerical threshold for naturalness, and the count of passing tests is not a perceptual score.

## Animates comparison beyond idle

Record both products' available behavior before judging relative quality. Keep feet and hands visible, include audio where relevant, record settings and actual timing, and retain complete trials. Match avatar, camera and audio when supported; document appearance/voice differences otherwise. An unavailable capability is reported explicitly, not replaced with a fabricated comparator.

| Scenario | What the comparison must expose |
| --- | --- |
| Quiet wait, then listening and thinking | Sustained presence, intentional attention and transitions without distracting performance. |
| Short agreement, disagreement, uncertainty and reassurance | Whether distinct speech acts receive appropriate gestures, with coherent preparation and return. |
| Long neutral Japanese explanation with pauses | Continued conversational performance, phrasing, repetition and whether silence is respected. |
| Expressive speech followed by calm speech | Arm/hand range, whole-body contribution and an unforced reduction in intensity. |
| Interruption during a gesture and immediate reply | Response to the other person without frozen limbs, abruptly cut poses or stale motion ownership. |
| Music start, sustained dance, tempo/phrase changes, pause and end | Actual dance capability, musical timing, whole-body coordination and foot support. |
| Music-to-conversation and conversation-to-music | Activity handoff, attention, stance recovery and priority between speaking and dancing. |

Judge movement naturalness, appropriateness to speech/music, and contribution to presence separately. Compare complete blinded paired trials where possible; do not infer a broad advantage from a quiet-idle sample, a successful asset conversion or a hand-picked demonstration. The current branch has not established the requested clear advantage over Animates.
