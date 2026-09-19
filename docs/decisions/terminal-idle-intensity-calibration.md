# Quieter Normal motion for terminal work

The September 19 review found Normal distracting while reading the terminal and
little visible difference between Normal and Lively. The requested reference is
the previous Normal motion at the new Lively setting, with a quieter Normal.

The public setting and persisted values remain 0–3. Body now converts the idle
setting to the existing strength scale at one boundary:

| Public setting | Idle strength |
| --- | --- |
| 0 | 0 |
| Calm, 0.5 | 0.25 |
| Normal, 1 | 0.5 |
| Lively, 2 | 1 |
| Over, 3 | 3 |

Values interpolate continuously between these anchors. Cold startup applies the
same calibration to recorded standing, procedural motion and head attention.
Normal's quiet recorded axial gains become torso 0.09 and head 0.03; Lively retains
the former Normal values 0.18 and 0.06. Supporting recorded pelvis/leg tracks,
source timing and contact gates remain unchanged. Clip weights retain their
existing maximum of one and individual reviewed ceilings.

Deliberate speech performances retain the previous public-setting weight curve,
including conversational hand gestures. Both Normal and Lively therefore keep
the reviewed 0.85 conversation weight. The quieter standing preference must not
pull the speaker's hands down toward the rest pose. Entry evaluation, playback,
active gain changes and pending loads use the same distinction. Zero still stops
automatic motion; values below Normal can still attenuate speech.

The recorded-body snapshot reports the public `intensity` and the calibrated
`effectiveIntensity` separately. SDK, settings, MCP and saved config continue to
share the public value without migration. This recalibrates the old default
contract described in `motion-intensity.md`; low-level motion-gain formulas and
the underlying recorded-dynamics profile remain unchanged.

Regression coverage checks the setting boundaries, cold startup, live transitions
to Lively/Over/zero, preservation of the recorded base, matching speech entry and
playback weights, and gain changes while a recording loads. Perceived motion
quality still requires live review with the actual avatar.
