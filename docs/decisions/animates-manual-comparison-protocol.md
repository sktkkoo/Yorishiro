# Animates: supported input paths and a short comparison protocol

Status: ready-to-run protocol, **not executed**. Checked 2026-09-14. The user's input-method choice remains pending; manual operation or Accessibility permission is not assumed. Follow the [quality strategy](motion-quality-strategy.md) and keep the overall comparison result **unverified** until the planned observations and human judgement exist.

## Supported-route investigation

- The installed public `/Applications/Animates.app/Contents/Info.plist` reports Animates `1.0.8`, build `24`, bundle `inc.animation.AniClaw`. Its one registered URL scheme has the form of a Google OAuth callback. It declares no `NSAppleScriptEnabled`, `OSAScriptingDefinition`, `NSServices`, or document-import types. These absent declarations do not prove that no private interface exists; they provide no supported utterance or avatar-selection interface to use.
- The [official product site](https://animates.ai/) and [company site](https://www.animation.inc/) did not expose API, CLI, SDK, or automation documentation in the pages and official-domain searches reviewed. A backend URL in application metadata is not a published API contract. No backend request, local service discovery, app configuration/session access, executable analysis, or proprietary asset extraction was performed.
- The [official App Store description and version history](https://apps.apple.com/us/app/animates-life-companions/id6758621319) describe in-app voice/text interaction and an earlier Gateway Text mode connected to OpenClaw. This suggests a user-facing input mode, not a verified way to remotely drive the installed avatar. OpenClaw's [external-app Gateway documentation](https://docs.openclaw.ai/gateway/external-apps) documents OpenClaw RPCs; it does not establish Animates' animation response, its selected session, or compatibility with this installed build. No Gateway was connected or reconfigured.
- The official [app-launch landing page](https://animates.ai/app-launch) exists, but the reviewed page does not document utterance or avatar parameters. No custom URL was invoked. No supported avatar-selection/import route was found.
- Existing CUA unavailability, untrusted Accessibility status, and AppleEvents `-1743` remain unchanged. This investigation did not retry those permissions. The next executable route is a user-confirmed normal input surface, operated manually or through an explicitly available authorized UI capability.

The public App Store page currently describes a different release from the installed native build. Keep the installed version in every trial; do not silently update the comparator or infer that a listed feature is present locally.

## Five short trials per product

Use the same input mode and the exact Japanese wording below in both products. Run products sequentially, with no concurrent rendering benchmark or music. Before each trial allow ten seconds to settle; record that interval too. Observe the complete trial, including late replies, failures, and unexpected behavior. This is a first comparison pass, not enough observations for the statistical superiority criterion in the [evaluation plan](motion-orchestration-evaluation.md).

| Trial | Input and timing | Observation window | Check |
| --- | --- | --- | --- |
| Quiet idle | No input after the settling interval. | 45 seconds | Breathing/body coordination, spontaneous gestures, repetition, pose or loop discontinuities. Any unsolicited speaking is logged; do not call that interval pure idle. |
| Listening | With normal voice input already available, read at a comfortable pace: 「今から、今日の作業について話します。朝は本棚を整理しました。次に、よく使う道具を机の近くに戻しました。途中で少し迷ったので、いったん休憩して考えました。最後に机を拭いて、明日の準備をしました。以上です。」 | The complete reading, then 15 seconds. | Response to the person's speaking, restraint while listening, coherent return to replying. Text entry alone is not a sustained user-speaking test; mark listening unavailable if a comparable voice route is absent. |
| Neutral explanation | 「部屋を片づける手順を、分類する、使う場所に戻す、最後に机を拭く、の順で、30秒ほどの落ち着いた説明にしてください。」 | 45 seconds from input submission/end of reading. | Hands, wrists, shoulder/torso support, meaningful pauses, whether the performance continues naturally through the reply and recovers afterward. |
| Emphasis | 「部屋を片づける手順を説明してください。『最初に分類することが大切です』を一度だけ少し強調し、ほかは落ち着いて話してください。」 | 45 seconds from submission. | Whether a salient gesture relates to the emphasized phrase, whether its preparation and recovery remain coherent, and whether emphasis is excessive or repeated. |
| Interruption | First give the neutral-explanation input. Five seconds after audible reply onset, say 「ちょっと待ってください。まず、分類のところだけを短く説明してください。」 | 30 seconds after interruption, including the preceding reply. | Speech/gesture cancellation or recovery, transition to listening, response to the narrower request. If the available input does not support interruption, report that limitation instead of substituting a stop button with different semantics. |

Do not prescribe a gesture, motion tag, nod, or pose to only one product. Generated answers can differ despite identical prompts; record the visible reply/transcript when available. This is a same-input product comparison, not a same-audio/output animation-system experiment. If a trial exceeds its planned window, retain the whole scheduled window and mark the reply unfinished; a later extension is a separately recorded follow-up.

## Capture and judgement

Capture only the selected application window with `SCContentFilter(desktopIndependentWindow:)`; microphone, audio, cursor and child-window recording remain off. Never substitute a full-display/rectangle capture. Keep feet and hands visible when the app permits; if framing cannot show them, mark physical support **not observable**. Record one complete file per planned trial, preserving the original and its capture diagnostics. A system-stopped recording is **incomplete**, not an app-motion defect. Do not restart because a performance looks poor.

For each trial record product/build, avatar, input mode, exact prompt, window dimensions, frame timestamps, completion status, and wall-clock start. The manual observer notes input onset/end, audible reply onset/end, emphasis phrase, and interruption time relative to the recording, including estimated timing uncertainty. This does not capture system audio. With only these coarse manual markers, fine speech/gesture or lip-sync timing remains unmeasured; do not infer it from a silent movie.

Review equal-duration unedited pairs in both product orders. Score motion naturalness, perceived presence, conversational appropriateness, and visible physical defects separately. Keep an explicit “not observable” option. Different avatars, voices, response text, language support, or framing are confounds, not corrected by a numeric average. Music/dance remain a later reference case and do not replace these first idle/listening/conversation trials.
