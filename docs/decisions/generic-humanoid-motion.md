# Shared automatic speech for imported VRM avatars

Status: runtime admission verified; per-avatar visual acceptance remains open.

## Change and hypothesis

The user observed Yori moving during conversation while another imported VRM
remained still. The default motion profile was bound to Yori's exact model hash,
so every automatic speech program was rejected on another model. This is an
admission failure, not evidence that retargeting itself failed.

When the caller does not supply an explicit profile, Body now selects the reviewed
Yori profile for its exact hash, otherwise a generic humanoid speech profile.
The generic profile shares the four current speech entries and their strength,
frequency, transition and recovery policy. Idle Chatting 2, Shrugging and upper
Idle remain excluded. Standard retains each entry's baseline; Lively and Over
retain full authored strength. Existing VRMA normalized-humanoid retargeting and
physical entry checks still run on the actual target rig.

The generic profile uses the existing target-calibrated lower-Idle foundation.
It does not acquire Yori's hash-bound recorded body bundle, contact annotations,
HandOnHip posture or occasional body performances. Speech does not require that
bundle and can still play if the independent foundation asset is unavailable.
Explicit caller-authored profiles retain their own model binding; selecting a
fallback never overrides a caller's rejection policy. No asset is modified.

## Reproduction and evidence

Baseline: `67075b8d`. Isolated Vite motion-quality lab, seed 738, viewport 1400 x
780, fixed 60 Hz stepping, 24 seconds of assistant-speaking at intensity 2.
The browser intercepted only the model fetch to supply existing local VRM files;
all other assets and the real Body/player were unchanged. The lab's static
"Yori" title is not the identity evidence; the loaded bytes' hashes below are.

| Avatar | SHA-256 |
| --- | --- |
| AvatarSample_A | `37b5f9db9cca625ef837f2a0245433da020da83fd75122a40d4da8289d36ca3a` |
| AvatarSample_B | `e6f7b50afd92fcea1f465ed6c0c5ce9640e7a3dad648bc6ea5e15055e42ed96b` |
| AvatarSample_C | `be9db865bda1965ee77703ccc17ab6b75a84386e2c5c47d06ebf0ddcb2cb24ea` |
| AvatarSample_M | `5da535efb7a31f56eb680bc918cfa4ffc80f99c3449e0264c5c2629c390ef5ec` |

All four loaded the generic profile with zero rejected programs, selected Idle
Chatting automatically at 600 ms, and advanced the real retargeted recording at
weight 1 over the independent lower-Idle foundation. No browser errors occurred.
Private snapshots, front/side/terminal screenshots and runner are under
`.motion-review/generic-qa/` and `.motion-review/generic-qa.mjs` in the generic-VRM
worktree. These files and the private avatars are not committed.

| Dimension | Before / after evidence | Result |
| --- | --- | --- |
| Acting/context | Hash mismatch rejected every speech entry; all four sample avatars now automatically select explanatory Chatting. | Runtime pass |
| Pose/coordination | Retargeted upper speech and calibrated lower support both active; Yori contact data absent. | Runtime pass; mesh clearance not accepted |
| Transition continuity | Existing entry matching remains active; Chatting selected at source 4.36 seconds in this seed. | Normal-speed review pending |
| Rhythm/repetition | Shared existing catalog policy; only 24 seconds measured. | Long-run review pending |
| Controls/salience | Lively actual player weight 1 on all four; shared default entries tested. | Runtime pass; visual salience pending |
| Frame delivery | Deterministic headless run, not native presentation. | Not observed |

Validation: all 719 Body tests across 39 suites pass, including unknown/missing
model hash, actual Body automatic selection with unavailable recorded support,
exclusions, Yori profile preservation and explicit-profile mismatch rejection.
TypeScript check passes. Existing retargeting and ownership tests remain intact.

## Decision and next review

This makes current speech acting available to compatible imported humanoid VRMs;
it does not certify every mesh's proportions, clothing clearance, hand placement
or foot contact. Native normal-speed conversation in full-body and terminal views
on the user's selected model remains pending. Review those dimensions before
adding target-specific contact or posture policy. The Yori-only foot IK validation
must not be presented as validation for these other avatars.
