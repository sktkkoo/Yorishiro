# Source contact candidates for full-body playback

The [generated metadata](recorded-contact-candidates.json) describes the ten
source-faithful Rokoko recordings from
[the source library preparation](source-faithful-library-metrics.json). It does
not admit them into the automatic catalog or certify a gesture's start/end.
Source provenance, retargeted shoe contact, authored performance and transition
quality remain separate checks.

Reproduce after preparing the original library:

```sh
node scripts/analyze-recorded-contacts.mjs
node scripts/analyze-recorded-contacts.mjs .motion-review/chatting-contacts.json 'Idle Chatting.vrma'
```

The script verifies each prepared file's SHA-256, replays it through the official
VRMA loader/mixer on its own source skeleton at 60 Hz, and retains hips XYZ.
Both ankle and toe must move below 0.04 m/s and stay within 0.015 m of that bone's
lowest height in the clip for at least 0.25 seconds to produce a support interval.
These explicit kinematic heuristics extend the existing source-contact audit;
they are not measured support forces or perceptual thresholds. Small holes are
reported without merging them, so an adapter must not assume every brief
threshold crossing is a new physical step. Low source feet also cannot make a
wall-dependent pose appropriate for unsupported standing.

`recordings[].contacts` contains `left`, `right` and `both` intervals in
`startSec`/`endSec`. Individual-foot intervals include maximum ankle/toe speed
and height above the clip's low point. `footExcursion`/`toeExcursion` also report
XYZ position ranges and maximum horizontal displacement from the interval's
first sample. `boundaryCandidates` retains the interior
endpoints and up to three poses with low body angular speed per both-support
interval. Candidates have 100 ms support margins; the interior low-speed picks
are separated by 800 ms. Each candidate contains hips/feet/toes world positions,
quaternions, linear and angular velocities, plus normalized local rotations and
angular velocities. Units are metres, seconds and radians. All times are local
to the prepared clip; add `inPointSec` (0.1 seconds) to obtain original FBX time.

| Recording | Source both-support examples (seconds) | Low body-speed candidates (seconds) | Consequence |
| --- | --- | --- | --- |
| Conversation | 0.15–25.00 | 7.5667, 15.75, 19.2667 | Source feet remain quiet through most of the recording; target contacts still require adaptation. |
| Chatting | 3.3333–16.5833; 19.0667–24.8167 | 4.3667, 6.35, 11.35, 24.7167 | The left foot leaves the support proxy between these long intervals. Locking both feet for the whole clip would remove that movement. |
| Chatting 2 | 2.2333–39.5167 | 8.4167, 9.3, 17.1667 | Entry and final recovery lie outside the long central support interval. |
| Looking Around 2 | 4.65–18.50; 18.5333–20.8833; 30.0167–31.3833 | 9.6667, 10.7667, 19.5833 | The long absence of both-support around 20.88–28.58 must not be bridged with unconditional double-foot locking. |
| Watching Something | 0.1667–11.8333; 18.2833–23.1167 | 8.3667, 9.2, 20.8, 21.6333 | Several quiet candidates exist, but source support alone does not identify an authored scene boundary. |

Watching exposes a limitation of instantaneous speed: its right ankle/toe move
66.06/67.58 mm horizontally from their initial position during the reported
0.1667–17 second interval. The left foot also accumulates 44–52 mm of movement
in its two long intervals. These measurements are on the original source rig,
before Yori retargeting. Treating these intervals as fixed anchors would correct
source drift as well as target error; the low-speed label alone does not justify
that alteration. By comparison, Looking Around's long intervals have 3.43/4.06 mm
left ankle/toe excursion and 5.30/2.54 mm right excursion. The script reports this
difference without silently changing thresholds or splitting contact episodes.

For offline adaptation, `sampleRecordedContactFrames(input)` exports the exact
60 Hz source samples; `analyzeRecordedContacts({ input, expectedSha256,
sourceSha256, inPointSec })` returns one metadata entry. Sampling a target avatar
uses its own retargeted clip; source world coordinates must not be compared
directly against Yori coordinates.

## Runtime review constraints

A synchronized upper/lower pair from one source is the preferred base. Both
parts must start atomically at one mixer time, entry phase and speed. The lower
part owns hips XYZ and runs continuously; a semantic gesture changes only the
upper-body contribution. Its recovery reveals the base at the current shared
phase, never a separately restarted upper-body clip. Blending a different quiet
Idle into the legs whenever a semantic gesture preempts the performance would
lose the source's weight shift again.

Replacing this base requires an outgoing support candidate and a compatible
incoming candidate on the target avatar. Align the incoming root position and
heading, then check both target ankles/toes, support state and velocities. A
common root offset that aligns one foot but moves the other is insufficient.
General quaternion loop closure and the six-second semantic gesture cap must
not truncate a full-body base. At a reviewed finite exit, hold the final pose
until the next admitted base is ready; do not automatically fade hips to rest.

Manual ownership and animation claims suspend the entire base group and cancel
late loading/activation. Restoration must revalidate the current target pose.
Conversation phase changes also need to reach the new base controller: stopping
the old ambient scheduler handle alone would leave a conversation base waving
after speech ends. Upper-body speech can settle promptly while the lower body
finishes reaching support. Reduced motion must not scale a standing root/leg
pose toward rest in a way that moves the planted feet.

Regression checks should cover atomic start and same phase after variable frame
steps; overlay start/end without lower-body phase reset; normal and interrupted
unit exits without root restoration; failed or cancelled loading; manual
preemption and claims; rejected two-foot alignment; and speech-to-listening
while one source foot is moving. These are behavior checks, not approval of the
recording's acting quality or a comparison with Animates.

Validation checked all ten recordings, 83 individual-foot intervals and 103
both-supported candidates for finite values, valid ranges and candidate support
margins. Repeating Chatting produced identical rounded metadata, an incorrect
source hash was rejected, and exported sample times were strictly increasing
with exact clip endpoints. These checks validate the artifact, not contact
ground truth.
