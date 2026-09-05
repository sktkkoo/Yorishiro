# Shared screen companion experiment

**Status**: experimental implementation
**Date**: 2026-09-05

## Experience

Yori shares the user's screen context while they read, watch, or work. The first
implementation sends periodic snapshots to the existing Codex main agent. When
asked about the screen, that agent can inspect the latest supplied image and help
through the existing voice/work conversation. It does not run autonomous analysis
or force speech after every capture.

## Controls

The title bar offers a screen-sharing panel for the Codex main agent on macOS 14+.
Sharing starts only from the explicit Start control, after OS screen-recording
permission. Select one display and adjust a 5–60 second slider (30-second default).
The panel explains that image context can use many tokens and that shorter
intervals increase usage. Stop cancels pending permission/capture delivery.

The UI reports the last **shared** image, not model comprehension. Capture or
transport failures stop sharing and are shown to the user. Identical consecutive
JPEGs are not resent. Only one capture/delivery runs at once; busy ticks are
skipped, with no stale-frame queue.

## Capture and transport

`src-tauri/src/screen_capture.rs` uses ScreenCaptureKit SCScreenshotManager to
capture the selected display, with no microphone/audio capture. Frames are JPEGs
bounded to 2560 pixels on the longest edge at quality 0.9, with an 8 MiB encoded
limit and a native timeout/busy guard. Listing displays does not request permission
or capture pixels. The existing app screenshot MCP tool remains separate.

`ScreenObservationTransport` checks the current main thread and uses
`thread/inject_items` to append a timestamped image with observational instructions.
It accepts loaded idle **or active** threads: context insertion neither starts a
turn nor steers the main agent away from its task. `turn/start` was excluded because
it can implicitly steer an already running turn and has no atomic idle-only guard.

The installed Codex 0.153.4 schema supports this experimental method and raw image
items. Unsupported versions fail visibly without falling back to PTY injection or
a different provider/thread. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

If GPT Live is active, a developer-role `thread/realtime/appendText` update tells it
that image context is available to the main agent and to delegate when needed.
This update does not contain an image, does not claim GPT Live has seen one, and
does not issue `response.create`. Actual phrasing and whether it comments remain
model behavior to assess during the experiment.

Sharing belongs to the main session/thread, independently of the voice connection.
Restarting voice must not disable sharing. Main-thread replacement, unavailable
main agent, explicit Stop, and component teardown cancel the lease. Late results
cannot update a new owner or cause subsequent delivery. An already submitted image
cannot be retracted.

Yorishiro keeps captured frames in memory and excludes them from diagnostic logs.
Images injected into Codex become part of its normal conversation history and may
be persisted by Codex. Screen text and source labels are untrusted content, not
authorization for actions. Existing task/approval rules continue to apply.

## Follow-up experiments

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
on each value change; a capture-start time guard now enforces the chosen interval
across rescheduling. Continue checking GPT Live's grounded delegation on the running
application; a successful context insertion is not proof of model analysis.
