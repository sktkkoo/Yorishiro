# Conversation performance strength

Reviewed on 2026-09-14 with the same Yori, camera, recorded standing foundation,
source phase, and Body updates. Private captures are in
`.motion-review/source-replay/gain/` and `chat-gain/`.

The previous neutral speech weights (0.384–0.432) were conservative heuristics,
not values supported by contact or acting measurements. Blending every local
rotation toward rest changed the performance: at Conversation time 8 s, the
hand that the source raises toward the chest stayed near the waist.

| Recording and sample | Weight 0.4 | Weight 0.85 | Interpretation |
| --- | --- | --- | --- |
| Conversation, 8 s, right hand height | 0.874 m | 1.048 m | The stronger contribution restores the readable raised-hand pose. Full weight gives 1.107 m. |
| Chatting, 0–25 s sampled hand-height span, left / right | 0.052 / 0.073 m | 0.175 / 0.235 m | Open palms at 8 / 15 s remain recognizable; authored rests at 3 / 25 s remain quieter. |
| Chatting 2, 0–40 s sampled hand-height span, left / right | 0.135 / 0.179 m | 0.391 / 0.486 m | Both hands often rise around the chest and shoulders. This is expressive conversation, not quiet contemplation. |

Conversation was viewed at 3 / 8 / 15 s with weights 0.4 / 0.85 / 1. Chatting
and Chatting 2 were compared at weights 0.4 / 0.85 at multiple source phases.
The capture scripts checked finite coordinates and matching simulation times.
No clear new shoulder, hand or torso defect appeared in the inspected stronger
poses. These are sparse pose observations, not continuous collision tests or
approval of every gesture and transition.

## Runtime decision

Use weight 0.85 for the three Rokoko conversation recordings. Neutral speech
uses that per-recording weight directly, removing the global 0.48 cap and 1.2
multiplier. Finite semantic performances still apply their requested intensity;
the user's overall motion intensity continues to scale either kind.

Relabel Chatting 2 as expressive conversation and restrict its current intents
to explanation and emphasis. Do not use its artificially reduced amplitude as
evidence that the authored performance conveys reflection or reassurance.
Choose quieter recordings or reviewed phrases for quieter behavior.

Before sampling, the director evaluates the candidate at its actual requested
strength against the current blended pose. A stronger but incompatible entry
is not forced merely to display a larger gesture. Returning from audible speech
also retires the explanatory loop when replacement candidates are unavailable.

The current automatic library still separates upper-body performance from its
reviewed standing foundation. Full-body source retargeting, contact adaptation,
authored phrase boundaries, continuous acting review and comparison with
Animates remain separate acceptance work.
