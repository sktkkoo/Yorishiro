# Quiet idle, motion intensity and restored posture variety

The September 15 review found continuous head and torso swaying, little difference between Normal and Over, and reduced variety after supporting legs were introduced. The user accepts the existing recorded foot motion and occasional large performances, but wants quiet periods, different poses and coherent upper/lower balance.

## Changes

- Normal remains setting 1; Lively is 2 and Over is 3. Previously the recorded contribution clamped every setting above 1 to the same result.
- Keep the original pelvis and leg trajectories, source timing and contact gates. Attenuate only spine, chest, neck and head rotations before mixer blending, relative to the same authored forward-facing reference at 16.2833333333 seconds across both units. Compensate inherited pelvis rotation in the spine rather than locking each local neck joint. Arms and fingers keep their authored local tracks.
- Normal quiet gains are torso 0.18 and head 0.06. After 45–90 seconds of eligible quiet time, an 8–10 second accent reaches at most 0.4/0.35 with two-second ramps. Over quiet gains are 0.65/0.45, with accents up to the original 1/1 after 20–40 seconds. Intermediate settings interpolate. A 150 ms time constant smooths setting changes; zero preserves the existing source-phase pause.
- Cursor attention previously added up to 12.6 degrees of head yaw independently of both recording weight and intensity. Its head contribution now ranges from 20% at Normal to the existing cap at Over; eye attention remains available.
- A separate upper-body schedule restores the calibrated quiet Idle and reviewed HandOnHip. After 15–25 seconds of idle or listening eligibility, a compatible, non-repeating candidate plays for 8–12 seconds before an 800 ms return. The first selection prefers HandOnHip only after availability, history and physical entry checks. A posture may replace the app’s own quiet ambient loop, while explicit performances keep priority. Supporting legs continue throughout. Semantic retrieval, availability, cooldown and physical entry gates remain in force.
- The finite, safe raised-hand survey remains a separate rare performance after 90–150 seconds of eligible quiet time. Unsafe Watching and whole Around clips remain excluded. Speech, manual ownership and animation claims take precedence over automatic posture changes.

## Validation

Actual Yori comparison over the same D/A source intervals found D head yaw excursion reduced from 84.56 to 5.07 degrees and head roll from 42.82 to 2.64 at Normal quiet gains. A head yaw fell from 62.52 to 3.95 degrees and roll from 50.95 to 3.18. These are geometric playback measurements, not perceptual scores. All sampled pelvis, foot and toe positions remained exactly unchanged; shoulder, arm and finger local rotations also remained unchanged. Gain 1 preserves the original recording exactly.

Front and side samples confirmed a substantially steadier forward-facing head without an obvious new torso collapse. Runtime integration additionally checks pending loads, settings transitions, quiet gaps, bounded posture changes, speech interruption and ownership. Numerical attenuation and passing tests do not establish biomechanical ground truth or superiority over Animates; native playback and continued user review remain necessary.
