# Local Codex Realtime model investigation

Status: Local debug experiment, default OFF. Named selection and live authentication matrix pending.
Issue: [#81](https://github.com/sktkkoo/Yorishiro/issues/81)
Investigated: 2026-11-14, installed `codex-cli 0.169.0`, Realtime v3, WebRTC.

## Local opt-in boundary

Ordinary users retain the exact existing `gpt-live-1-codex` request on every
version. This PR adds no model-event listener, model-specific records, capability
requests, polling or extra communication unless local debug is explicitly enabled.
It does not enable an experiment by installing or updating the application.

The shared local `realtime-debug.ts` switch (`setRealtimeDebugEnabled(true)`) uses
only this WebView's `yorishiro:realtime-debug` local-storage key. Exact `1` enables
it; missing/blocked storage is OFF. It is not a pack setting, synced preference,
remote command or global rollout. Enable it locally before reconnecting to test
Auto; disable with `setRealtimeDebugEnabled(false)`. Disabling immediately stops
new model-event processing and model metadata recording. An established model
connection is not switched mid-session; the next connection restores the ordinary
request. Existing pre-PR connection diagnostics are unchanged.

## Verified capability

The installed binary's experimental protocol was generated with:

```sh
codex app-server generate-json-schema --experimental --out /path/to/scratch/schema
```

`ThreadRealtimeStartParams.model` is an optional string override. The schema does
not enumerate allowed Realtime models. `ThreadRealtimeStartResponse` is empty;
`ThreadRealtimeStartedNotification` reports the thread, protocol version and
optional session ID, without a model. `model/list` describes general Codex models,
not an auth-scoped Realtime catalog. `modelProvider/capabilities/read` exposes
image generation and web search, not Realtime model availability.

The [exact 0.169.0 source](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/realtime_conversation.rs)
selects the model in this order: request override, configured
`experimental_realtime_ws_model`, then the protocol default. Its v3 default is
`gpt-live-1-codex`. This establishes request construction, **not** account access,
backend acceptance, or the model actually serving a connection. The
[app-server guide](https://learn.chatgpt.com/docs/app-server) explains generating
bindings for the installed version.

## Opt-in Auto policy

Only with local debug enabled, on Codex 0.169.0 and later stable versions, Auto omits `model` so Codex owns its
configured/default choice. This removes Yorishiro's unconditional override of an
explicit Codex configuration. Future Codex defaults remain server decisions.

Older or unrecognized versions retain the existing `gpt-live-1-codex` request,
which was introduced for the 0.149.x ChatGPT-authenticated v3 rejection. Diagnostics
label this `legacy-compatibility`, not server selection or an effective model.
Keeping that existing path does not claim API-key availability has been verified.
Both authentication modes use the same conservative version policy; neither mode
is used as evidence that another model is available.

No speculative named choices are exposed. Auto needs no persisted override. A
persisted named preference and selection UI remain pending until an authoritative
capability surface or an account/version-scoped verification supplies usable
options. Public Realtime API model names and the backing text model are not
substitutes for that evidence.

## Diagnostics and errors

Only while local debug is enabled, the existing bounded local
`readRealtimeDiagnostics()` records contain a
`model` object for account-identified attempts: selection policy, requested model
(or null for server selection), app-server version, authentication mode and v3.
`effectiveModel` stays null with `effectiveModelSource: not-reported` even after
successful RPC, SDP or the app-server `started` notification.

If the current WebRTC data channel actually receives a `session.created` or
`session.updated` event containing a model identifier, that identifier is recorded
with source `session-event`. This is conditional observation, not a claim that
Codex v3 emits these events on every connection. A different identifier is labeled
`different-from-request`; that can be routing or aliasing, and is not assumed to
prove a fallback. No session prompt, credentials, transcript, SDP or raw error is
copied into these diagnostics. Stopped, replaced and stale channels cannot change
the current attempt's identity.

A startup model rejection is surfaced with the original error and the statement
that no alternate model was tried. Rejections and successful request acceptance
never establish an effective model. Voice fallback remains separate and does not
switch models or protocols.

## Validation matrix and remaining acceptance

| Version / protocol | Authentication | Request | Evidence / outcome | Effective model |
| --- | --- | --- | --- | --- |
| 0.169.0 / v3 | ChatGPT | Auto, no override | Installed schema and tagged source; client-boundary accepted/rejected fixtures | Unknown unless a session event explicitly reports it |
| 0.169.0 / v3 | API key | Auto, no override | Installed schema and tagged source; client-boundary accepted/rejected fixtures | Unknown unless a session event explicitly reports it |
| Older/unknown / v3 | Both | Existing compatibility override | Regression fixtures preserve current request; no new backend availability claim | Unknown unless reported |

Tests cover default OFF (unchanged model request and no new event listener or
model metadata), opt-out while connected, and reconnect after opt-out, plus each
auth mode with opt-in, no override on current versions, older-version
compatibility, asynchronous rejection without alternate-model retry, unknown
identity after negotiation, reported differences, redaction, stale channels and
reset on reconnect. These are client-boundary tests, **not live provider results**.

No authentication was switched, credentials copied, live app restarted or paid
inference test initiated for this investigation. Live accepted/rejected/fallback
behavior must still be tested independently with an explicitly provisioned ChatGPT
account and API-key account, recording version, v3, requested model, effective
identity when observable and any backend rejection. Until then #81's live matrix
and persisted verified named selection acceptance criteria remain open.
