# Actual-avatar motion review, 2026-09-19

Status: paired engineering capture completed. This review does not establish human
acceptance, native terminal frame delivery, or mesh collision clearance.

## Reproducible capture

`scripts/review-motion-quality.mjs` opens an isolated localhost Vite server and
headless Chrome using the actual Yori VRM and installed animation assets. It never
connects to or reloads the native app. The same development page is copied onto a
frozen baseline checkout so both versions use identical observation code.

The baseline is a `git archive` of `632b9140`, placed in sibling directory
`../Charminal-motion-qa-baseline`. It shares installed dependencies, not source
files, with the development checkout. Both checkouts run `fetch-assets` against
the existing local asset store. No external animation or model is downloaded.

Optional external tools must already exist. Set `YORISHIRO_PLAYWRIGHT_MODULE` to
the local Playwright module, `YORISHIRO_CHROME_PATH` to Chrome, and optionally
`YORISHIRO_FFMPEG_PATH` to a local ffmpeg executable. The last option creates an
encoder symlink inside that capture's ignored tools directory instead of asking
Playwright to download its encoder. Example commands, after setting those paths:

```sh
node scripts/review-motion-quality.mjs --root ../Charminal-motion-qa-baseline --revision 632b9140 --label baseline --port 1443 --seconds 500 --live-seconds 32
node scripts/review-motion-quality.mjs --label candidate --port 1444 --seconds 500 --live-seconds 32
```

Ports 1430 and 1439 are rejected to avoid the known native development surfaces.
File watching and HMR are disabled. The manifest hashes production TypeScript files
in `src/core/body` (excluding tests), the review page's module, production camera
framing, the Yori model, animation files and animation manifests. A capture fails if the source
fingerprint changes during the run.

## Conditions and exported evidence

- Seed 738 governs random choices throughout the isolated page, including choices
  made after construction. Runs with different eligible catalogs can still produce
  different selections, so matched input is not matched joint trajectories.
  The sequencer change also starts the contiguous reviewed support run at source
  time 7.0833 rather than the baseline's 15.6667 seconds.
- The fixed-step run contains 300 seconds of quiet Normal idle, listening,
  thinking, a 45-second explanation, an emphasis request, interruption and return,
  then Calm/Normal/Lively/Over/zero/resume changes. Total: 500 seconds at 60 Hz.
- The live segment uses animation-frame wall time without clamping or fixed-step
  film resampling: idle, listening, explanation, emphasis, interruption and return.
  Commands and actual execution timestamps are retained. Browser video includes
  loading time; the frame trace identifies the measured playback interval.
- One composed avatar is shown from fixed front and side cameras and a 400 × 640
  terminal-camera preview. The latter uses production FOV, initial framing and
  vertical head tracking. Lighting is held constant. The real terminal compositor,
  scene pack effects, user camera changes and terminal output load are absent.
  The user's read-only live snapshot used camera position approximately
  `[0.0942, 1.2908, 2]`, FOV 35 and tracking enabled; the lab's default distance is
  1.6. This is not an exact reconstruction of that custom view and does not close
  the upward-looking-head observation.
  Front and side cameras match exactly between captures. Initial terminal camera
  position is head-derived: baseline `[0.0654, 1.1146, 1.6]`, candidate
  `[0.0900, 1.1077, 1.6]`. Thus this comparison preserves the framing policy,
  not an identical initial terminal camera or pose.
- Each final-frame sample contains normalized local joint rotations and
  avatar-space joint origins, actual mixer action IDs/weights/phases, scheduler
  selection and recorded support phase. Requests are not counted as playback.
- Contact proxies report foot/toe marker displacement and height; hand and shoulder
  heights are measured relative to the upper chest. A planted marker can coexist
  with shoe/clothing penetration. These are not skin collision measurements.
- A constant-velocity prediction filter identifies large angular or joint-origin
  residuals with acceleration thresholds. It is an engineering triage filter,
  not a naturalness score. Its avatar-space positional prediction differs from
  the production composed-motion monitor; intentional curved movement can flag.
  Their counts must not be equated. The candidate monitor's own export is retained
  separately, when available.

Outputs are private under `.motion-review/quality/<label>/`: asset/source manifest,
compressed 60 Hz frame records, 10 Hz selection traces, summaries, screenshots,
production monitor export and live video. No private assets or recordings belong
in Git. The checked-in [numerical evidence](motion-quality-actual-avatar-metrics.json)
contains source hashes, fixture comparison, scenario statistics and artifact
digests. Baseline metadata originally also hashed tests; the compact record
retains production files only, matching the final runner policy.

## Results

Both captures completed 30,000 simulated frames and 1,920 live frames with no page
or asset errors. All 45 asset hashes and the observer module hash match; runtime
source fingerprints stayed unchanged during each capture.

| First 300 simulated seconds, Normal idle | Baseline | Candidate |
| --- | ---: | ---: |
| Actual HandOnHip starts | 5 | 2 |
| HandOnHip occupancy | 54.37 s (18.1%) | 21.58 s (7.2%) |
| Upper Idle occupancy | 47.57 s | 0 s |
| Held frames at adjacent source cut, 15.6667 s | 53 | 0 |
| Held frames at actual source wrap, 23.3667 s | 54 | 54 |
| Total support hold time | 1.783 s | 0.900 s |
| Largest foot/toe marker displacement | 2.03 mm | 3.29 mm |

The artificial approximately 50 ms pause at the adjacent source cut is gone.
The real wrap remains deliberately gated. These short holds are visible in the
phase trace even when the prediction filter does not flag a large discontinuity.
Foot marker displacement did not improve; its small measured range does not
establish sole contact or cloth clearance.

For Calm, Normal and Lively, the actual recorded upper-strength trace changes
from baseline `0.5 / 1 / 1` to candidate `0.25 / 0.5 / 1`. Normal conversational
clips still reach 0.85 action weight. This verifies distinct control values while
preserving speech pose contribution; different selected source phases prevent
using these runs as a precise perceptual amplitude comparison.

The baseline live trace also selected HandOnHip after interruption, at about
26.56 seconds, and kept it into resumed listening. Its 32-second RAF interval
contained no 100 ms stalls; p95 was 16.7 ms. This isolates a motion-selection
problem in a smooth-frame-delivery lab; it does not establish that the user's
native app never stalls. The encoded 25 fps film lasts 33.96 seconds including
startup and is separate from the 60 Hz measured RAF trace.

The candidate's live interruption had no new subsequent performance selection;
its p95 frame interval was 16.8 ms, maximum 33.2 ms, with no 100 ms stalls.
The longer simulation still selected a later HandOnHip during listening, so the
result establishes reduced recurrence, not a universal listening prohibition.
Independent prediction candidates changed from 51 to 48 simulated moments and
12 to 27 live moments. Different actions and phases were played; these counts
are not an improvement score or counts of visible defects. The production
monitor separately recorded 27 live pose candidates, zero stalls and zero invalid
samples; its frame ring and events are exported for inspection.

Both front/side/terminal screenshots and live contact sheets were inspected.
Baseline samples show conversational hands around the abdomen and the later
hand-on-hip pose; a candidate sample at 345 seconds shows Chatting 2 with hands
higher in front of the torso. The clips and source phases differ, so this is not
proof that the original reported low-hand gesture was corrected. Sparse samples
show no gross pose collapse, but do not certify continuous cloth/arm clearance,
head/gaze presentation or naturalness. Continuous normal-speed perceptual review
and the user's acceptance remain open.

The baseline's largest wrist prediction residuals repeat at the same source
phases with one performance action at a steady 0.85 weight and no support hold.
For example, the original Chatting 2 right-wrist quaternion keys use linear
interpolation at 30 Hz: rotation speed changes approximately
198 → 576 → 337 → 98 degrees/second between source times 2.933 and 3.033 seconds.
The composed replay preserves the corresponding abrupt speed changes. Chatting
has another source change from about 552 to 166 degrees/second around 9.933–9.967
seconds. These are candidates for source-curve and visual review, not evidence
that every diagnostic peak is a transition defect. The measurements alone cannot
classify fast acting versus capture noise, and do not justify smoothing every
joint or slowing every gesture.

## Validation

The full suite reports 252 passing files and one failing file: 3,319 passing tests
and 21 failures. All 21 failures are in unchanged `use-screen-sharing.test.ts` and
reproduce on the frozen `632b9140` baseline (30 passing and 21 failing tests in
that file on each version), where jsdom lacks the canvas implementation required
by the screen-sharing fixture. No motion test failed. Build and TypeScript,
Biome (745 files), TypeDoc, Rust Clippy with all targets/features, and Rust format
checks passed. Build retains its existing approximately 4.61 MB App chunk warning.

## Scope of conclusions

Conversation inputs currently drive the real Body phase and ownership paths with
synthetic phase cues. No audio file plays, so acoustic/phrase alignment is not
tested. Five simulated idle minutes do not replace five minutes of actual terminal
work. Fixed-step geometry and isolated Chrome wall-clock delivery are reported
separately. Normal-speed visual inspection remains distinct from contact sheets,
coordinate measurements, passing tests and the user's final judgment.
