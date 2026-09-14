# Explicit playback of reviewed whole-body recordings

The runtime can now preserve the hips XYZ track through `AnimationPlayer`,
`MotionOptions`, and `CharacterAPI.play`. Previously the runtime discarded every
position track, even when an offline conversion retained valid source motion.

```ts
character.play(reviewedAnimationRef, {
  rootMotion: "preserve",
  loop: false,
  weight: 1,
  speed: 1,
  fadeInMs: 400,
  fadeOutMs: 600,
});
```

This opt-in accepts full-body, immediate, non-looping performances on the
performance layer. It rejects masks, foundation ownership, loops and matched
transitions because the current loop conditioner and phase matcher do not
establish root-path closure or full-body contact compatibility. The default
remains in-place; automatic upper-body selection does not enable preservation.

The source and target must have finite positive reference hip heights. The
source must provide finite hips XYZ values with increasing finite key times;
the retargeted result is checked again. Invalid preserve requests fail instead
of silently falling back to a stationary hip. A failed preparation does not
replace an active performance. The parsed source is shared without mutation,
with separate cached retargeted variants for each policy.

## Verification

Official VRMA loader fixtures and the real Three.js mixer exercise VRM 0 and
VRM 1 scaling, both cache orders, concurrent requests, invalid metadata and
values, option rejection, cancellation, natural completion and restoration of
the original hips position. Body regressions verify both SDK entry routes
forward the option.

The source lab additionally compares the same prepared Conversation clip
through direct official playback and the actual runtime player:

- `source-motion-lab.html?runtime=1`: source-faithful candidate.
- `source-motion-lab.html?contacts=1&runtime=1`: Yori contact-adapted candidate.

Both were captured in a fresh local browser on 2026-09-14 at 0, 3, 8, 15 and
25 seconds, by seeking and by continuous integration. All 60 paired hips/foot
comparisons had zero coordinate difference at the measured precision, with
no page or resource errors. The hips moved 41.63 mm from the initial sample
for the source-faithful clip and 37.75 mm for the adapted clip, so the agreement
does not result from freezing the pose. The paired 8-second images matched.
The source-lab entry starts without a fade for this fidelity comparison.

Private evidence is in `.motion-review/runtime-source/`, `runtime-contact/`
and `runtime-root-preservation-qa.json`. The same local capture driver accepts
either URL through `YORISHIRO_SOURCE_LAB_URL`.

This verifies explicit single-clip ingestion. It does not approve Body
overlays, arbitrary model contact adaptation, cross-clip transitions, a new
automatic catalog entry, or superiority over Animates. The corrected Yori
candidate is tied to the model hash recorded in its preparation report.
