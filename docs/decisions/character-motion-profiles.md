# Character motion profiles and whole-body composition

**Status**: first integrated implementation; visual acceptance is tracked separately
**Last updated**: 2026-09-19

## Problem and boundary

A catalog search, occasional timer, recorded standing layer and explicit command
previously made separate eligibility and ownership decisions. A reviewed asset
could become an indefinite ambient fallback; an asynchronous replacement could
suspend standing support before its asset loaded. Catalog growth also risked
implicitly giving every character the same acting repertoire.

`CharacterMotionProfile` now authors the automatic repertoire and composition
contract for one character. `MotionCompositionController` grants each automatic
role and standing layer from the actual execution state. The existing
`MotionScheduler` remains the sole priority/preemption arbiter; the profile is
not a second scheduler. `AnimationPlayer` remains the mixer and mechanical
entry evaluator.

The runtime `Body` constructor uses the default profile and accepts an internal
`motionAssets.motionProfile` override. There is no public persona/pack setting,
profile editor, runtime profile switching, or new SDK permission model in this
change. A future character can supply a separately reviewed profile through that
internal seam without adding clip-specific branches to Body.

## Authored data and admission

Each program supplies an explicit catalog entry, role (`ambient`, `posture`,
`occasional`, `speech`), review reference, mask, support contract, gain policy and
optional requirement for an active recorded standing layer. Profiles supply an
optional exact avatar SHA-256 binding, support-layer permissions and bounded
timer ranges. The default binds the reviewed Yori model hash. Other avatars and unknown hashes
therefore lose automatic upper performances and retain independently calibrated
lower/procedural support. This is an intentional conservative compatibility change.
The production ThreeRuntime path and both development motion labs compute the
loaded VRM bytes' SHA-256 and pass it into Body; absent crypto/hash does not
implicitly authorize the Yori repertoire.

Compilation snapshots and freezes nested program/entry arrays and cadence data,
so editing one author's data cannot change an already constructed character.
Avatar mismatch admits no automatic programs and disables the avatar-specific
recorded base; the independently calibrated lower-body fallback retains its own
player gate. Missing review, duplicate entries, invalid numeric fields or cadence,
unbounded occasional programs, and unsupported compositions are reported as
rejections. Structural validation cannot establish acting or mesh compatibility:
profiles are trusted internal authored data and still require the linked review.

The first supported automatic composition is **upper-body performance over retained
standing support**. Automatic full-body/support replacement is rejected rather
than accepted with an unimplemented contract. Explicit manual motion commands
keep their existing priority and playback interface; they can take lower-body
ownership through the physical commit lifecycle below.

The default admits six explicitly named speech entries, one bounded posture and
two finite occasional performances. Adding another catalog entry does not expand
this list. `Shrugging` and the upper-body `anim:Idle` performance are absent from
all automatic roles. The lower-body `anim:Idle` foundation is prepared independently;
its availability does not admit the upper performance. HandOnHip belongs only to
`posture`, with an 8–12 second ownership lease, 180-second cooldown, and no forced
first choice. Empty listening/ambient candidates leave the admitted standing
support in place.

## Composition and physical lifetime

The shared plan consumes grounded conversation phase, activity, claim state,
settings, recorded support/upper ownership, scheduled request and timer ownership.
It produces recorded/fallback support permission, upper/axial permission and
role grants. Selection, timer dispatch and post-load commitment all cross the
same profile and plan boundary. Frame evaluation reuses the input, output and
nested grant records and reads the scheduler's stable request reference.

A request becoming current is not a physical commitment. The player loads and
prepares the asset, waits for its existing transition policy, then rechecks the
chosen entry against the current support/mixed pose at the latest playback weight.
Only after that gate does Body commit ownership and suspend any displaced lower
support. Rejection or load failure leaves the existing valid support/playback
intact. A commit callback that invalidates the request cannot resurrect an action.

The player's semantic `completion` starts its recovery; `stopped` resolves when
its actual mixer action is gone. Committed lower owners remain exclusive until
`stopped`, so standing support cannot re-enter during a full-body recovery merely
because the scheduler slot is empty. Multiple overlapping recovery owners are
tracked separately.

A failed replacement can leave the outgoing physical playback without its former
scheduler handle. The actual playback retains automatic gain and sampled posture
expiry, so reduced motion, library disable, interruption, conversation changes
and the original posture deadline still stop it. Finite speech that retains a
valid handle can finish its reviewed normal-audio-end recovery. Transient
composition/entry rejection rolls back the uncommitted director selection and
history; it does not permanently blacklist a prepared asset. Missing assets are
excluded during preparation.

## Intensity and evidence

Standing dynamics use the [terminal idle calibration](terminal-idle-intensity-calibration.md).
Speech programs use the separate authored speech gain: Normal and Lively retain
the existing conversational pose weight, while zero and Calm still reduce it.
The gate and actual entry use the same latest gain; a setting change during load
does not restart or shorten the authored fade.

Regression coverage includes two isolated profiles, avatar mismatch, unsupported
composition, nested authoring mutation, default exclusions, independent lower
preload, bounded posture/cooldown, failed-load support preservation, recovery
ownership, retained-playback controls/expiry, transient history rollback, and
real-mixer entry/fade behavior. Generic ownership tests explicitly inject their
own synthetic profile; production-default admission has separate integration tests.

These checks establish admission and execution behavior, not natural acting,
hand height, clothed-mesh clearance, or perceptual continuity. Complete semantic
preparation/stroke/hold/recovery annotations are not available for every clip.
The existing mechanical entry checks and selected contact metadata are partial
contracts; there is no universal quiet-frame transition requirement or new
inertialization implementation. Review actual-avatar results in the
[motion quality evidence](motion-quality-actual-avatar-review.md), and observe the
final composition with [composed-pose diagnostics](composed-motion-diagnostics.md).

## Revision history

- 2026-09-19: Added explicit character repertoire, shared composition grants and
  physical commit/recovery ownership without replacing the existing scheduler.
