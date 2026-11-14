# Local microphone mute

Issue: [#158](https://github.com/sktkkoo/Yorishiro/issues/158)

The connected title-bar microphone controls local input. A separate hang-up
button ends the conversation. `Cmd+Shift+M` on macOS and `Ctrl+Shift+M` elsewhere
toggle local input in every view mode while the app has focus. Plain `Cmd+M`
keeps its standard minimize behavior. Existing character-view modifier-tap
controls use the same host action.

`runtime/local-microphone.ts` defines the host input adapter. Its transport ID,
connection state, user mute intent, device interruption, and actual sending state
are distinct. GPT Live supplies the first adapter; future meeting transports can
map the same control to their own input route. This does not implement meetings,
global shortcuts, or a global mute across several simultaneous transports.

| State | Local input | Connection and remote output |
| --- | --- | --- |
| Connected, sending | Live enabled track | Preserved |
| Connected, user-muted | Existing track disabled | Preserved |
| Connected, device interrupted | Input unavailable; mute intent retained | Preserved until actual capture failure |
| Explicit disconnect or ended/inactive capture | Tracks stopped and resources released | Existing stop/error lifecycle |

Mute does not request microphone access, stop tracks, send a realtime stop/start,
change threads, reset persona context, or finalize the conversation log. Device
recovery cannot clear user mute. Mute chosen while capture is pending applies
before adding the resolved track to WebRTC. Existing retries keep that intent.
Reconnecting does not occur merely because an unmute action is requested.

Automated coverage checks input toggles, identity/resource continuity, unchanged
remote gain/graph, device events, late capture, teardown, shortcut routing and
title-bar accessibility. Physical microphone privacy and audible output still
require a live device check; unit tests do not measure sound at the speaker.
