# Shared screen companion experiment

**Status**: experimental implementation
**Date**: 2026-09-05

2026-09-21: Claude Codeにも共有UIを拡張。必要時に最新画像をMCPで取得する経路は[Claude screen sharing](claude-screen-sharing.md)を参照。以下はCodex実験導入時の記録で、現在の更新間隔は10〜180秒。

## Experience

Yori shares the user's screen context while they read, watch, or work. While sharing
is active, it sends periodic snapshots to the existing Codex main agent and requests
a fresh capture when the user starts speaking in GPT Live. When asked about the
screen, the agent can inspect the latest supplied image and help through the existing
voice/work conversation. Captures do not initiate autonomous analysis or force speech.

## Controls

The title bar offers a screen-sharing panel for the Codex main agent on macOS 14+.
Sharing starts only from the explicit Start control, after OS screen-recording
permission. Select one display and adjust the periodic interval with a 5–60 second
slider (30-second default). Speech requests a fresh capture without waiting for that
interval, only while sharing is already active. The panel explains that image context
can use many tokens and that more frequent updates increase usage. Stop cancels
pending permission/capture delivery.

The UI reports the last **shared** image, not model comprehension. Capture or
transport failures stop sharing and are shown to the user. Identical consecutive
JPEGs are not resent. Only one capture/delivery runs at once: a speech request joins
an operation already in progress, without adding another capture or delaying audio.
If a periodic update becomes due during a slow delivery, the next capture starts as
soon as delivery finishes, with no stale-frame queue or additional whole-interval wait.

## Capture and transport

`src-tauri/src/screen_capture.rs` uses ScreenCaptureKit SCScreenshotManager to
capture the selected display, with no microphone/audio capture. Frames are JPEGs
bounded to 2560 pixels on the longest edge at quality 0.9, with an 8 MiB encoded
limit and a native timeout/busy guard. Listing displays does not request permission
or capture pixels. The existing app screenshot MCP tool remains separate.

The tracker validates the selected main thread and tracks load/unload notifications.
`ScreenObservationTransport` uses that current owner and a single
`thread/inject_items` to append a timestamped image with observational instructions.
It does not repeat `thread/read` for each capture. An unload racing an injection
is rejected by the server; it cannot start or resume a thread.
It accepts loaded idle **or active** threads: context insertion neither starts a
turn nor steers the main agent away from its task. `turn/start` was excluded because
it can implicitly steer an already running turn and has no atomic idle-only guard.

The installed Codex 0.153.4 schema supports this experimental method and raw image
items. Unsupported versions fail visibly without falling back to PTY injection or
a different provider/thread. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

If GPT Live is active, a developer-role `thread/realtime/appendText` update tells it
that image context is available to the main agent and to delegate when needed.
The capture/delivery finishes without waiting for that metadata acknowledgement.
Notifications keep at most one RPC in flight and one latest waiting timestamp;
queued updates are discarded when their sharing lease or voice owner is revoked.
When voice connects after sharing began or reconnects within the same sharing
lease, it receives the latest already-shared timestamp immediately. This replays
only availability metadata, without capturing or reinjecting the image, and keeps
the original capture time. Stopped sharing and replaced threads cannot replay it.
This update does not contain an image, does not claim GPT Live has seen one, and
does not issue `response.create`. Actual phrasing and whether it comments remain
model behavior to assess during the experiment.

For an explicit where/which/point request, Live is instructed to delegate the user's
question, inspection of the attached image, and the pointer action together. Once
the target is grounded, the main agent is guided to show it before a lengthy
explanation and answer briefly. It must inspect a fresh shared image when the
attachment is stale or the target moved; capture arrival alone never requests a mark.

Sharing belongs to the main session/thread, independently of the voice connection.
Restarting voice must not disable sharing. Speech callbacks from an old voice
connection are ignored. Main-thread replacement, source changes, an unavailable
main agent, explicit Stop, and component teardown cancel the lease. Both periodic
and speech requests use that same ownership guard, so late results cannot update a
new owner or cause subsequent delivery. An already submitted image cannot be retracted.

Yorishiro keeps captured frames in memory and excludes them from diagnostic logs.
The local `ScreenSharing` development log records capture/context durations and
fixed outcome names. It never receives pixels, source labels, or frame/lease/thread
identifiers. These timings end at context insertion, not model comprehension.
Images injected into Codex become part of its normal conversation history and may
be persisted by Codex. Screen text and source labels are untrusted content, not
authorization for actions. Existing task/approval rules continue to apply.

## Follow-up experiments

The child prototype adds [shared-display reference marks and independent controls](shared-screen-pointers.md)
to this existing capture/voice path. It does not replace the sharing setup.

- User-adjustable resolution and selecting a window or rectangular region were
  explicitly deferred until the basic experience is tested.
- Test timely autonomous comments separately from passive context delivery.
- Measure token use, latency, interruptions, and usefulness at different intervals.
- Mobile access and a small floating companion window remain separate experiments.

## Validation

Automated checks cover opt-in capture, cancelled permission/capture requests,
owner changes, deduplication, transport failure, interval changes without capture
bursts, narrow settings panels, and existing voice behavior.
Native tests cover bounded landscape/portrait image sizes and invalid dimensions.

The first live display image reached the main agent on 2026-09-05 at 12:56:35 UTC.
User testing exposed an idle-only delivery gate and voice-reconnect ownership;
these were corrected so sharing can accompany work and survive a voice reconnect.
Changing display images were then received repeatedly at 10-second and 30-second
intervals while the main agent worked. Slider dragging exposed immediate captures
on each value change; a capture-start time guard now enforces the chosen periodic
interval across rescheduling. Speech can request an earlier update while sharing
remains active. Continue checking GPT Live's grounded delegation on the running
application; a successful context insertion is not proof of model analysis or a
measurement of voice-to-pointer latency.
