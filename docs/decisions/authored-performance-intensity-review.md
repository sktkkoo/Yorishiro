# Authored performance strength review

**Date**: 2026-09-20
**Status**: runtime policy implemented; native visual acceptance pending
**Baseline revision**: `5f1c1e2cca45d33712562213225d787d9ade1820`

## Change and hypothesis

During native review, Thankful looked too small at an explicit preview weight
of about 0.399 (catalog baseline 0.42 at public intensity 0.95). The requested
Thankful Standard strength was about 60%, followed by the broader instruction
that all automatic authored motions should be 100% at Lively and above.

Previously, the public speech gain was capped at one before multiplying each
clip's baseline. Lively therefore left Thankful at 0.42 and Chatting at 0.85.
Changing only Thankful's catalog value would not fix that shared policy.

The percentages here mean animation blend weights, not proportional hand
travel, perceived energy or playback speed. Partial quaternion blending can
change hand height and contact. The desired controls are testable independently
of whether the resulting acting and geometry look natural.

## Runtime decision

Keep a separate Standard baseline for each automatic performance. For speech,
this is the director's per-clip weight, including its existing finite semantic
intensity adjustment. For ambient, posture and occasional programs, preserve
the existing quieter Standard baseline: half of the director/program weight.
Thankful's catalog weight changes from 0.42 to 0.6. Other catalog weights remain
unchanged.

Given Standard weight `s` and reviewed ceiling `c` (one unless explicitly lower):

- Between zero and Standard, the weight is `s * setting`.
- Between Standard and Lively, interpolate continuously from `s` to `c`.
- Lively and Over (`setting >= 2`) use `c`, never more than one.

Clamp the Standard weight to the ceiling first. A finite speech intensity can
still quiet or emphasize Standard acting, but cannot leave a Lively clip below
its ceiling. Thankful at neutral semantic intensity 0.5 is 0.6 at Standard and
1 at Lively/Over; a deliberately smaller semantic cue remains smaller at
Standard. Source speed, selection frequency and cooldowns are unchanged.

The legitimate exception to full weight is an explicit `maxWeight` admission
constraint. No current default program has a lower cap; future/custom reviewed
programs must not lose one. An incompatible full-weight entry remains rejected.
Increasing the setting does not authorize an excluded source or bypass pose,
velocity, support, avatar, composition or claim checks.

Selection evaluates the same weight used by playback. Automatic request records
retain the unscaled baseline so loading-time changes, physical entry evaluation
and active 350 ms gain changes all use the same function. Returning from Lively
to Standard restores the individual baseline. An unchanged loading-time weight
does not restart the player's fade ramp. Explicit SDK/MCP animation requests
retain their supplied weight even if the same clip is in the automatic catalog.

Supporting pelvis/leg playback, recorded axial accents, procedural idle gain and
their calibrated 0–3 dynamics remain separate. Full authored performance weight
does not mean multiplying these support or accent layers to 100%, nor does it
extrapolate a clip beyond its source pose at Over. The public setting, config
and source assets are unchanged.

## Reproduction and evidence

The regression scenario drives Body with a synthetic normalized skeleton and
prepared catalog programs; it isolates strength calculation from source loading
and uses the actual director, composition and scheduler paths. It covers zero,
Calm 0.5, Standard 1, intermediate 1.5, Lively 2 and Over 3, plus setting changes
while a clip loads and after activation. Source speed is checked unchanged.

| Dimension | Before | Candidate | Result |
| --- | --- | --- | --- |
| Controls | Low catalog baselines stayed attenuated at Lively. | Speech and timed/ambient programs reach their ceiling at Lively/Over; Standard preserves individual baselines. | Runtime pass; visual acceptance pending. |
| Transition admission | Strength used during selection had to match actual entry. | Full-weight entry is evaluated before selection and at physical commit; rejected entries do not play. | Regression pass. |
| Manual control | Explicit preview weight could be supplied directly. | Explicit requests retain their supplied weight, including while the public setting changes. | Regression pass. |
| Pose, support and acting | Thankful was reported too small; several separate jitter/contact observations remain open. | No native candidate replay or mesh/contact judgment in this isolated change. | Not observed. |
| Rhythm and delivery | Separate selection and frame-delivery policies. | No cadence or renderer changes. | Not observed. |

Run focused checks with:

```sh
npx vitest run src/core/body/motion-intensity.test.ts src/core/body/motion-integration.test.ts src/core/body/motion-director.test.ts src/core/body/motion-profile.test.ts src/core/body/motion-composition.test.ts src/core/body/motion-catalog.test.ts
npx tsc --noEmit
npx biome check src/core/body/index.ts src/core/body/motion-intensity.ts src/core/body/motion-intensity.test.ts src/core/body/motion-integration.test.ts src/core/body/motion-catalog.ts
```

The six focused files pass 175 tests; the wider `npx vitest run src/core/body`
passes 700 tests in 38 files. TypeScript, the scoped Biome check and `git diff
--check` pass. Numeric mapping and mocked entry
results do not certify naturalness, continuous mesh clearance or native frame
delivery. No live app was reloaded or changed for this isolated implementation.

## Next review

Replay the same admitted clip and source phase at Calm, Standard, Lively and
Over, using the actual Yori and fixed body plus terminal cameras. Include the
previously observed Thankful preparation, chest-hand gesture and return, then
both conversation clips. Record camera, avatar/asset hashes, actual phase,
weight and frame trace with normal-speed video. Check hand height, body contact,
entry/recovery and the live gain change; a source spike is not repaired by
increasing its weight. User visual acceptance and contact review remain open.
