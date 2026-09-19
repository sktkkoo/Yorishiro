# Runtime foot contact after composition

**Status:** bounded runtime candidate; normal-speed visual acceptance pending.
**Review date:** 2026-09-20. Baseline: `5f1c1e2cca45d33712562213225d787d9ade1820`.

## Observation and cause

The user reported floating/sliding feet during explicit full-body Idle Chatting
and Idle Chatting 2 playback, including Idle Chatting started at source 8 s. The
requested correction is shared contact-aware runtime IK, not individual motion
patches or an unconditional two-foot freeze. The 8 s start was accepted for that
preview; this change does not restrict arbitrary diagnostic start phases.

The explicit MCP route previously removed the source hips translation while
applying the full-body leg rotations at weight 0.8075. It also suspended recorded
standing support. Actual-avatar replay confirms that retaining the authored hips
trajectory removes most of the support drift; partial-weight retargeting still
leaves a smaller residual. The automatic conversation route already retains the
recorded lower body under an upper-body performance. These are different
compositions, so changing its automatic selection alone would not repair the
observed full-body route.

Existing [offline contact adaptation](recorded-target-contact-adaptation.md)
provides the contact policy and bounded two-bone method. It does not previously
correct the live final composition. This change adds that runtime layer and keeps
the offline preparation intact. No motion asset or avatar is modified.

## Runtime contract

- A character profile has source contact annotations independent of its automatic
  acting programs. Removing a performance from automatic selection cannot admit it
  again through contact data. The default data is bound to the exact Yori model.
- The player verifies the source bytes' SHA-256 and duration, then parses those
  same verified bytes. Only finite, immediate, full-body performance playback uses
  this path. Unknown sources, loops, foundation layers, matched transitions and
  upper/lower-body masks retain their existing behavior.
- Source hips translation is preserved for eligible playback. Common pelvis and
  supported-leg corrections run after composition, before humanoid propagation.
  They are restored before the next mixer update, new binding, retirement or
  disposal, so IK cannot accumulate into the source or Three's saved rest values.
- Only long stationary episodes from the existing source contact report are
  annotated: at least 2 s, with both ankle and toe displacement within 15 mm.
  Annotations identify support, not semantic phrase boundaries. Chatting's left
  heel raise between the annotated episodes remains unlocked. There is no
  motion-name branch in the solver.
- Each contacting foot acquires its current horizontal placement after the
  incoming crossfade completes. A 350 ms quintic ramp acquires/releases the lock.
  The standing rest ankle/toe midpoint provides floor height. The shared pelvis
  offset and analytical two-bone solve preserve authored knee pole and foot world
  orientation. An unsupported leg retains its local rotations; it can follow the
  small common pelvis correction in world space.
- Positive intensity weight changes do not weaken the lock. Zero and stop fades
  release it. Outgoing contact continues through its release fade while the new
  stance enters; the new stance does not inherit the old stance's anchors.
- Per-avatar-scale limits are 60 mm common pelvis correction, 12 mm additional
  reach projection, 60 mm independent displacement and 25 degrees local leg
  correction. Exceeding a limit rejects/reacquires instead of stretching a leg.
  The measured candidate remains well below these limits. Uniform scale is
  supported; nonuniform scale, unreliable frame deltas over 100 ms and invalid
  rig data fail closed. Root transform discontinuities and ownership changes
  reacquire contacts. Zero delta preserves the paused solve.

The SDK/MCP `footContact: false` option preserves source diagnostics. MCP now also
accepts the existing `rootMotion: "preserve"` and `mask: "upper-body"` options, so
reviewers can independently compare root preservation, runtime IK and retained
standing support. Omitted options apply reviewed contacts where eligible; they
do not make an unknown clip eligible.

## Reproduction

After `node scripts/fetch-assets.mjs`, run:

```sh
node scripts/review-runtime-foot-contact.mjs .motion-review/runtime-foot-contact-final
node scripts/review-runtime-foot-contact.mjs .motion-review/runtime-foot-contact-full-weight 1
```

This uses the real player, controller, official VRMA loader and Yori skinned shoe
vertices. It compares stripped root/no IK, preserved root/no IK and preserved
root/runtime IK for both clips at source 0 and 8 s, weight 0.8075, speed 1,
200 ms entry fade and fixed 60 Hz through clip completion. Source time advances
during the fade. Full private frame traces remain under the specified ignored
output directory. The compact committed report is
[runtime-foot-contact-metrics.json](runtime-foot-contact-metrics.json).

Exact inputs:

| Input | SHA-256 |
| --- | --- |
| Yori | `739a1515cffe09c17a535eb52a11f88640fc7728b86b9e4c74f00c353437b7cd` |
| Idle Chatting, 26.73326683 s | `d485a7dabb21d4b8809433a23ddf68a43ba5a31761d7106925c6bd8917e56e0d` |
| Idle Chatting 2, 41.73303986 s | `b0c1a26c46e24e03b9fef3b5c61977fea814921f2293527cb3f0706ed39fd4d2` |

A separate deterministic browser pass used the real Body, seed 738, viewport
1400 x 780, two seconds of recorded standing before manual playback, 30 seconds
of playback and a 600 ms stop followed by two seconds of recovery. Sixteen cases
covered both clips, both starts and the three modes above plus upper-body
retained support. All cases completed without page errors or IK guard rejections.
Private snapshots and sampled poses are in `.motion-review/body-foot/`; the local
runner is `.motion-review/review-body-foot.mjs`. It used a separate headless browser
and isolated server at port 1547, with native preview untouched.

The development lab exposes `motionQualityLab.command({ manual: { animation,
options: { weight: 0.8075, loop: false, speed: 1, startTimeSec: 8 } } })` and
`command({ stopManual: true })` for repeating these starts. `startTimeSec` here is
a development-only diagnostic option, not a new public scheduling contract.

## Measurements and interpretation

Maximum support midpoint drift from the first steady sample, in millimetres.
Each side's maximum is over its annotated episodes, excluding 0.6 s around
acquisition/release boundaries. This measures steady contact, not fade acceptance.

| Clip / start | Prior stripped L / R | Preserved only L / R | Runtime IK L / R | Maximum pelvis correction |
| --- | ---: | ---: | ---: | ---: |
| Chatting / 0 s | 39.114 / 153.780 | 4.934 / 18.953 | <0.001 / <0.001 | 19.008 mm |
| Chatting / 8 s | 34.401 / 152.646 | 4.654 / 20.425 | <0.001 / <0.001 | 20.261 mm |
| Chatting 2 / 0 s | 70.998 / 79.164 | 8.868 / 8.145 | <0.001 / <0.001 | 13.551 mm |
| Chatting 2 / 8 s | 71.271 / 71.878 | 10.494 / 8.885 | <0.001 / <0.001 | 11.239 mm |

The largest local leg correction across complete candidate replays is 2.457
degrees. Foot world orientation error remains below 0.001 degrees. No candidate
guard rejects occurred. The ankle/toe midpoint is a floor proxy: actual skinned
shoe penetration still reaches 2.637 mm. Exact center locking does not mean exact
sole clearance or natural-looking knees. These are diagnostics on this model,
not universal thresholds or a perceptual score.

An additional weight 1 replay of both starts and both clips retained <0.001 mm
steady contact drift, with no guard rejects, maximum pelvis correction 29.359 mm
and local leg correction 3.320 degrees. This covers the full-strength numerical
case; it does not establish native Lively visual acceptance.

| Dimension | Before / after evidence | Result |
| --- | --- | --- |
| Acting and context | IK does not change source upper-body acting. User rejected Chatting 2's gesture near 3–4 s in a separate preview; automatic exclusion is independent work. | Needs work; not admitted by this report |
| Pose and coordination | Large full-body support drift reduced to measured contact; supported ankle orientation and unsupported local leg rotations preserved. Front/side/terminal static samples showed no obvious leg inversion. | Numerical pass; visual acceptance pending |
| Transition continuity | Acquisition/release and owner lifecycle are bounded and tested. Browser stop/replacement scenarios complete. Steady-state drift excludes fades. | Normal-speed boundary review pending |
| Rhythm and repetition | No automatic selection or cadence change. | Not evaluated |
| Controls and salience | Partial weight 0.8075 and source 0/8 reproduced; positive gain, zero, scale and ownership covered by regression. | Runtime pass; perceptual comparison pending |
| Frame delivery | Fixed-step CPU/browser runs do not establish native frame pacing. | Not observed |

Regression covers contact release, authored unsupported lift, uniform/nonuniform
scale, root change, pause and ownership; player tests cover verified-byte parsing,
root preservation, failed provenance, mask/loop exclusions and outgoing release.
MCP validation tests reject malformed options before releasing the current owner.
Validation commands include affected Vitest suites, `npx tsc --noEmit`,
`npm run build`, Biome, `cargo fmt --check` and offline Clippy with warnings denied.
The final nine affected Vitest suites passed all 448 tests. Production build,
TypeScript, formatting, Clippy and TypeDoc validation passed.

## Decision and next review

Keep this as a reviewable shared runtime candidate. It corrects the demonstrated
composition's geometric support and supplies diagnostics, without freezing both
feet unconditionally or weakening recorded support gates. It does not detect
contacts automatically for arbitrary unannotated clips, handle terrain, certify
other avatars, or fix upper-body jitter, face/camera jitter or source acting.
Fail-closed guards release their correction immediately on an unreliable frame,
excessive solve or root discontinuity; a rejected frame can therefore visibly
release the current correction before reacquisition. The measured steady runs
did not trigger those guards. Recovery after a native stall is not visually
accepted by this report and must be checked separately from steady foot locking.

Full-body manual stop can still leave the recorded Around support unable to pass
its re-entry gate; the same result occurred in both baseline ablations and this
candidate. Upper-body retained-support playback keeps Around active. Resolving
that existing full-body handoff needs a separately compatible return, not bypassing
the gate or claiming this IK solved the entire support graph.

Native normal-speed full-body/side and terminal review remains pending because the
user's sequential preview must remain unchanged during background implementation.
After integration, replay both starts and gain/stop/preemption changes, check heel
lift, knee continuity, foot sole clearance and the return to standing alongside
frame timing. Only that review can close perceptual acceptance. Chatting 2 remains
an explicit diagnostic case regardless of its automatic acting exclusion.
