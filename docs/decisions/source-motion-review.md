# Original conversation recording: conversion review

Reviewed on 2026-09-14 using `source-motion-lab.html`, the same Yori avatar in
both lanes, matching camera and lighting, full-body tracks, weight 1 and speed 1.
No procedural overlays, body masks, loop conditioning or contact correction are
applied. This compares ingestion paths; it is not the production motion player.

The left lane loads the existing `Idle Conversation.vrma`; the right loads the
private original-FBX conversion candidate under
`.motion-review/source-assets/prepared/Idle Conversation.vrma`. Candidate time
zero is original FBX time 0.1 s. The existing clip aligns approximately to that
point; its original conversion settings are not known. The shared comparison
ends at the shorter clip duration, approximately 25.1666 s.

## Observations and limits

Both direct seeking and continuous 60 Hz integration were sampled at 0, 3, 8,
15 and 25 s. All ten captures loaded successfully, with no page, console-error
or resource-error events. The two lanes' hips and foot markers were finite.
The maximum coordinate difference between seek and integrated playback was
approximately 6.1e-15 m, confirming the sampled body poses use the same clock.
Seeking resets spring state after the mixer and VRM humanoid have updated;
this does not claim that spring dynamics match continuous playback.

The five continuously integrated poses were visually inspected. Both avatars'
whole bodies, hands and feet were visible, with no initial T-pose or obvious
limb deformation in these samples. Arm, hand and head poses closely matched.
The visible change was principally the restored hips translation. Existing
hips stayed fixed; the candidate's sampled lateral positions reached about
-4.1 cm relative to its initial X position. These are pose observations, not
measurements of contact sliding or a perceptual improvement score.

The loader warned about approximately zero rest-hips height in the old VRMA.
It also automatically created look-at quaternion proxies in both lanes.
Neither warning prevented replay. The candidate's separate fidelity report
records a valid nonzero rest-hips height and finite retargeted channels.

Sparse screenshots cannot approve gesture preparation, stroke and return,
whole-body support, continuous foot contact, clothing intersections, hand
articulation between frames, speech alignment, or the quality of acting.
Restoring hips movement did not produce a dramatic change in the sampled arm
acting. Review a continuous original-speed film before drawing timing or
naturalness conclusions.

Keep three decisions separate:

1. **Source/reference fidelity:** the converter's round trip on the original
   source skeleton is measured in
   [source-faithful-conversation-metrics.json](source-faithful-conversation-metrics.json).
   Those errors measure preservation of the authored data.
2. **Yori retarget acceptance:** body proportions, floor support and readable
   acting on this avatar require target-specific continuous review. The sparse
   captures above establish rendering and sampled-pose consistency only.
3. **Product quality and Animates comparison:** runtime masking, intensity,
   transitions and real speech/music scenarios require a separate comparison.
   This laboratory contains no Animates footage and establishes no advantage.

## Reproduction

Use the original archive described in
[recorded-motion-quality-direction.md](recorded-motion-quality-direction.md),
then prepare the private candidate with `scripts/prepare-recorded-fbx.mjs`.
Start the local Vite server with assets available, then open
`http://127.0.0.1:1437/source-motion-lab.html`.

```sh
node scripts/prepare-recorded-fbx.mjs
npm run dev -- --host 127.0.0.1 --port 1437
node scripts/capture-source-motion-lab.mjs
node scripts/capture-source-motion-lab.mjs --film
```

The optional driver uses an already installed Playwright/browser; it downloads
neither. Set `YORISHIRO_PLAYWRIGHT_MODULE` and `YORISHIRO_CHROME_PATH` if they are
not found by default. `YORISHIRO_SOURCE_LAB_URL` accepts a localhost page only.
The film additionally requires local `ffmpeg`. It records 600 fixed-clock
frames at 24 fps, checks clock and marker values, and exports a 25-second
`source-comparison.mp4`. Producing the film does not approve its visual quality.

Outputs remain ignored under `.motion-review/source-replay`: `seek-*.png`,
`replay-*.png`, `observations.json`, and optionally `frames/` plus
`source-comparison.mp4`. The committed driver and this report contain no binary
recordings or screenshots.
