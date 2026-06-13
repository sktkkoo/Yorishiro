# Pack execution classes

> Read this when thinking about **safe execution models for publicly distributed packs / sandboxing / the boundary between amenity and scene packs**. Audience: dev / AI.

**Status**: active
**Last updated**: 2026-06-13

**Implementation note**: The public registry / community distribution feature for packs and `/charm:prepare-publish` are not yet available. The publish flow / registry review / machine checker described here are design requirements that must be met before community distribution is enabled.

## TL;DR

Pack `type` is product semantics, not a security boundary. For public distribution, packs carry an `executionClass` in their manifest, separate from `persona` / `scene` / `effect` / `amenity` / `ui`.

| executionClass | Speed | Freedom | Security | Public distribution policy |
|---|---:|---:|---:|---|
| `declarative` | High | Low–Med | High | MVP default. Data-only, no JS evaluation |
| `isolated-js` | Med | Med | Med–High | Required for amenity distribution. Killable boundary + SES + capability RPC |
| `trusted-main-thread-js` | Highest | Highest | Low | Bundled / local / curated only. Never labeled as sandboxed |

Amenity packs will eventually be user-distributable. However, publicly distributed amenities must default to `isolated-js`, with `system.exec` / `fs` / `net` / `notify` etc. running as host-mediated capabilities. If the isolated runtime and permission UX are not ready for MVP, **public amenity distribution is deferred past MVP**.

`source` is also an input to security policy. `executionClass` answers "how is it executed"; `source` answers "where did it come from" — two independent axes.

| source | Definition | `trusted-main-thread-js` |
|---|---|---|
| `bundled` | Shipped with Charminal, reviewed and released together with the app | Allowed |
| `local` | Placed directly in `~/.charminal/packs/` by the user. Includes packs created by `/charm:create` | Allowed. Not labeled as publicly distributed |
| `curated` | Distributed pack with publisher / hash / review metadata allowlisted by Charminal | Conditionally allowed. Not labeled as sandboxed |
| `community` | From public registry / third-party / unknown publisher | Blocked |

`source` is a different axis from MCP trust tiers. MCP tiers address the trust level of host tool callers; pack source addresses the provenance of pack artifacts.

## Decisions

### 1. Separate pack type from execution class

`scene` / `effect` / `persona` / `amenity` / `ui` describe what the pack means in Charminal. They do not restrict JavaScript execution permissions.

Any JS loaded via `dynamic import()` on the main thread can execute network access, timers, DOM access, global mutation, prototype pollution, and interference with the loader or runtime objects at module top-level.

Therefore "scene packs are safe" and "only amenity packs are dangerous" are not valid classifications. Public distribution must always consider `executionClass` separately from `type`.

### 2. `declarative` means data-only

`declarative` does not mean "a JS object with no handlers." It means **a data-only artifact with no JS evaluation**.

Allowed forms:

- `scene.json`
- `scene` field within the manifest
- Effect recipe JSON
- Persona prompt / reflex mapping JSON
- Static asset metadata validatable by schema

Not allowed:

- `scene.js` that merely `export default`s an object
- `persona.js` that exports a static definition
- `effect.js` that returns a declarative-looking config

Evaluating a JS module is arbitrary code execution. To call something data-only for public distribution, the host must parse JSON / data, validate against a schema, and have the Charminal runtime handle rendering, registration, and reaction execution.

Even data-only values are not trusted unconditionally. Remote URLs are default-deny, `url(...)` goes through the asset resolver, `javascript:` / `data:` / absolute filesystem paths are rejected, and numeric / enum values are clamped to bounded ranges. Asset resolver and rendering primitive granularity follow [`effect-rendering-primitives.md`](effect-rendering-primitives.md).

Rejecting JS entries alone is not sufficient for `declarative`. The host also rejects / sanitizes the following as hostile data:

- SVGs are prohibited by default for community `declarative` packs. If allowed, only a sanitized subset with scripts / event handlers / external references stripped
- JSON object keys `__proto__` / `constructor` / `prototype` are rejected by schema validation
- JSON.parse output is never deep-merged into host objects. Use null-prototype objects or field-by-field copying when needed
- Free-form CSS strings are avoided; structured primitives (color / opacity / blur / enum) are preferred
- CSS `url(...)` is rejected or restricted to the asset resolver
- Remote URLs are default-deny until `net` permission and domain allowlisting are implemented
- `data:` / `blob:` / `file:` / absolute filesystem paths / path traversal (`../`) are default-reject

This checklist is enforced in both the `declarative` pack public registry review rules and the loader schema. It is not a documentation-only advisory.

### 3. `isolated-js` is killable boundary + SES + capability RPC

`isolated-js` runs pack JS in isolation from the Charminal main thread / app realm.

Basic form:

- Run inside a killable boundary: Web Worker / sandboxed iframe / Tauri sidecar process
- Inside the boundary, use SES / Hardened JavaScript `lockdown()` + `Compartment` or equivalent
- `lockdown()` runs only inside the isolated runtime, not in the Charminal app realm
- `fetch`, `fs`, `notify`, `system.exec`, DOM, Tauri IPC are not passed as ambient globals
- Guest bundles are not executed directly via Worker module / `importScripts()` / dynamic import
- A host-controlled loader fetches the bundle source and evaluates it inside the Compartment
- Packs send capability requests to the host via JSON-RPC / message RPC
- The host validates against manifest permissions, user policy, pack hash, rate limits, and timeouts before executing
- No host objects are passed to packs; only serializable values are returned

SES restricts the object graph's authority but cannot stop infinite CPU loops or excessive memory allocation on its own. It must always be combined with boundary kill / timeout / crash recovery.

SES / Compartment has faced endowment and object graph escape issues in the past. `isolated-js` is not designed as "game over if SES breaks." Assumed failure modes and remaining defenses:

- Even if SES is bypassed, the pack cannot escape the Worker / iframe / sidecar directly
- Even if RPC stubs inside the Worker can be called directly, the host dispatcher re-validates via permission / schema / rate limit / timeout / audit log
- Host objects, DOM, Tauri IPC, Node builtins, and raw `fetch` are never placed in Worker globals / endowments
- Values returned from the host are structured-clone–compatible data only. Functions / class instances / live object references are never returned
- Panics / infinite loops / memory pressure are handled by boundary kill and crash recovery

Defense is therefore three-layered: SES object-capability restriction + killable boundary + host-side capability gate.

### `isolated-js` initiation gate

If `isolated-js` remains unimplemented for too long, community pack authors will push for `trusted-main-thread-js` access. Work on `isolated-js` MVP begins when any of the following occurs, even before amenity public distribution:

- Pack requests that `declarative` cannot express appear consistently on the public registry
- Curated `trusted-main-thread-js` exceptions grow, blurring the curated / community boundary operationally
- Demand emerges for pure-compute / transform packs (JS execution needed, but no system capabilities)
- A minimal permission UX, audit log, and pack disable / kill UI become feasible

The minimal MVP may start with Worker + host-mediated capability RPC + strict global removal, but a state without SES must not be labeled `isolated-js` for safety purposes. A pre-SES stage is treated as an internal milestone (`worker-js-experimental` equivalent) and does not gate community amenity release.

### Capability RPC validation

Pack → host RPC in `isolated-js` requires more than structured-clone–compatible messages. The host dispatcher validates per method:

- Capability / method name must exist in the allowlist
- Must match manifest permissions, user policy, pack hash / review metadata
- Request ID / protocol version / pack ID / execution instance ID must match the current session
- Payload passes method-specific schema validation. Unknown fields are rejected by default
- String length, array length, object depth, and payload byte size have upper bounds
- `system.exec` uses argv, not shell strings. Workspace scope and command allowlist are enforced
- `fs` paths are canonicalized and confined to the declared scope
- `net` enforces domain allowlist, method allowlist, response size cap, and timeout
- Unknown methods, permission mismatches, schema failures, and rate-limit hits are logged in the audit log

The host never passes host objects to packs, and RPC results are serializable data only. Results are also schema-validated to prevent type confusion.

### 4. `trusted-main-thread-js` is an explicitly dangerous zone

Packs that need low-latency access to Three.js / DOM / WebGL / React UI may require the main thread for performance.

In that case, the pack is never presented as sandboxed. It is treated as `trusted-main-thread-js` and must always be accompanied by one of:

- Bundled
- Local-only
- Official curated
- Verified publisher + allowlist
- Unsafe confirm

`trusted-main-thread-js` risk is mitigated through provenance and operational controls, not runtime restrictions.

### `sandbox` declaration (capability ladder)

`executionClass` describes the boundary in which pack JS / data is evaluated. The `sandbox` declaration is a separate axis that describes the capability backend for script-executing packs. It is a top-level manifest field, at the same level as `executionClass`.

The capability ladder is `declarative` → `sandbox: "wasm"` → `sandbox: "native"`. The shorthand `sandbox: "wasm"` / `sandbox: "native"` is used when discussing the ladder, but the canonical manifest shape is `sandbox: { "backend": "wasm" }` / `sandbox: { "backend": "native" }`.

Phase 0 defines the schema in advance and rejects unknown backends / unknown fields fail-closed. Until backend enforcement exists, packs with a valid `sandbox` declaration are also rejected as unimplemented. See [`pack-sandbox-strategy.md`](pack-sandbox-strategy.md) for details.

## Default execution class per pack type

| Pack type | MVP public default | Future public distribution | Notes |
|---|---|---|---|
| `scene` | `declarative` | `declarative` default. JS scenes are `trusted-main-thread-js` | Existing `scene.js` treated as local / legacy / trusted |
| `scene` (R3F component) | Bundled-only | `trusted-main-thread-js`. User pack support in separate spec | Main-thread React + Three.js context. R3F host integration required |
| `effect` | `declarative` recipe or curated `trusted-main-thread-js` | `declarative` if renderer primitives suffice; custom renderer is trusted | Visual expressiveness and security conflict easily |
| `persona` | `declarative` persona data | `isolated-js` if handler JS needed; main thread is trusted | Push prompt / reflex mapping toward data-only |
| `amenity` | Not publicly distributed in MVP | `isolated-js` default | Deferred until permission UX is complete due to system capabilities |
| `ui` | Not publicly distributed in MVP, or curated only | Mostly `trusted-main-thread-js`; isolated UI explored later | Direct React / DOM access cannot be a safety boundary |
| `init.js` | Not publicly distributed | Not publicly distributed | Local user's free-form layer. Not listed in pack registry |

## Amenity pack handling

Amenity packs will eventually be user-distributable. However, amenities are functional automation and carry higher risk than Presence Harness expression layers.

Prerequisites for public amenity distribution:

- `executionClass: "isolated-js"` is implemented
- `system.exec` uses argv, not shell strings
- `system.exec` has command allowlist / per-command approval / workspace scope
- `fs` has path scope with read / write / create / delete granularity
- `net` has domain allowlist
- `notify` has rate limiting as a low-risk capability
- Capability requests / results are recorded in audit log
- Pack disable / kill / safe mode available in both UI and CLI
- PTY write API remains nonexistent. MCP tool equivalents (`terminal_prefill` / `write_terminal_input`) are also prohibited for now ([`mcp-trust-tiers.md`](mcp-trust-tiers.md) "PTY tool handling")

If these are not in place, public amenity distribution is excluded from MVP.

## Manifest design

`type` and `executionClass` are separate fields.

```json
{
  "$schema": "https://charminal.dev/schemas/pack-manifest.schema.json",
  "id": "workspace-backup",
  "type": "amenity",
  "executionClass": "isolated-js",
  "version": "1.0.0",
  "charminalVersion": "^0.1.0",
  "entry": "bundle.js",
  "artifact": {
    "sha256": "sha256-...",
    "sizeBytes": 18432
  }
}
```

`declarative` packs must not have an `entry` pointing to JS.

## Implementation status

The current implementation is an MVP gate, not a complete sandbox.

Implemented:

- `executionClass` / `artifact` added to SDK manifest types
- Rust discovery passes `manifest.json.executionClass` to TS
- TS policy evaluates `declarative` / `isolated-js` / `trusted-main-thread-js`
- `declarative` + JS-like entry rejected before import
- `isolated-js` halted as reserved / unsupported
- `community` source `trusted-main-thread-js` blocked by default
- User scene assets allow pack-relative paths only; remote URLs / `data:` / `file:` / absolute paths / traversal / CSS `url(...)` are rejected
- `/charm:create` / `/charm:update` generate/edit `.js` / `.tsx` packs as local-only `trusted-main-thread-js`, with prompts explicitly preventing public amenity / `isolated-js` / unsafe asset / PTY write creation

Not yet implemented:

- `declarative` artifact data loader / schema registry
- `permissions` manifest schema and enforcement
- `/charm:prepare-publish` equivalent: local trusted pack → public artifact conversion flow
- Web Worker / iframe / sidecar + SES runtime
- Capability RPC / audit log / rate limiting
- Install UX with permission diff / local responsibility notice

## `/charm:create` and public distribution

`/charm:create` is an authoring flow for users to quickly experiment locally. Its output is treated by default as `source: "local"` + `executionClass: "trusted-main-thread-js"`. This is the pathway where "a user trusts and runs their own code in `~/.charminal/packs/`" — it does not imply meeting community distribution safety standards.

Therefore, to publish a pack created with `/charm:create`, it must go through a separate flow that converts it into a publish-ready artifact. The working name is `/charm:prepare-publish`.

However, `/charm:prepare-publish` and the pack publication UI / registry submission are not yet available. The responsibilities defined here serve as acceptance criteria for when public distribution is implemented.

`prepare-publish` responsibilities:

1. Read the local pack's manifest / entry / assets
2. Explain to the user why `trusted-main-thread-js` cannot be published as community
3. Detect parts that can be downgraded to `declarative`
4. Generate publish directory / artifact
5. Modify manifest for public use
6. Reject JS entry, unsafe assets, remote URLs, out-of-schema fields, prototype pollution keys
7. Run schema validation and review rules
8. Display artifact hash / size / permission diff / executionClass diff
9. Output a checklist before submitting to registry review

`prepare-publish` is machine-check first. Human review is limited to "decisions machines cannot make definitively." The same checker is reused across CLI / `/charm:prepare-publish` / registry CI. The checker is implemented as a pure module so that candidates passing locally never get a different verdict from the registry.

Automated checker categories:

| Category | Hard reject | Warning / info |
|---|---|---|
| Manifest / policy | Schema invalid, `declarative` + JS entry, community `trusted-main-thread-js`, unimplemented `isolated-js`, executionClass downgrade / unsafe change | Missing description, stale `charminalVersion` range |
| Declarative data | Unknown field, prototype pollution key, depth / array length / string length / file size cap exceeded, CSS free-form / `url(...)` / unsafe URL | Unused field candidate, value identical to default |
| Assets | Reference outside pack dir, symlink escape, extension / MIME mismatch, size cap exceeded, image dimension cap exceeded, SVG not allowed, video rejected in MVP | Unused asset, duplicate asset, compression opportunity |
| JS / TS static scan | JS entry remaining in publish candidate, forbidden global / import / dynamic import / eval / DOM / Tauri / Node builtin / `fetch` / timer / AudioContext / React / Three.js usage | Explanation of why conversion is impossible, manual rewrite suggestion |
| Integrity | Artifact hash mismatch, lockfile mismatch, review metadata mismatch | User-visible hash diff / permission diff / size diff display |
| Future `isolated-js` | Forbidden global, permission / capability request mismatch, bundle size cap exceeded, dependency policy violation | Dependency license / vulnerability warning |

JS / TS static scanning uses AST, not regular expressions. Detected: `import`, dynamic `import()`, `eval`, `Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `document`, `window`, `localStorage`, `AudioContext`, `@tauri-apps/api`, `node:*`, `fs`, `child_process`, `process`, `Buffer`, JSX / React / Three.js / R3F usage.

Machine check limitations:

- Social-engineering wording
- Deceptive UI
- Excessively offensive presentation
- Copyright / license / brand similarity
- Obfuscation to evade review
- Values that are schema-valid but semantically dangerous

These remain targets for registry review. Packs with any hard reject cannot be submitted to registry review. Warnings are explained to the user, and `/charm:prepare-publish` offers fix suggestions where possible.

Conversion examples:

| Local authoring pack | Public artifact | Notes |
|---|---|---|
| `scene.js` | `scene.json` or manifest `scene` field | Convert to `declarative` scene without JS evaluation |
| `persona.js` + `persona.md` | Persona data JSON + `persona.md` | Schema-ize only prompt / reflex mapping / world settings |
| `effect.js` | Effect recipe JSON | Only effects expressible via runtime primitives are publishable |
| `amenity.js` | Future `isolated-js` bundle | Aligned to capability permission and RPC API. Not published in MVP |
| `ui.js` / `ui.tsx` / `ambient-ui.js` | Generally not convertible | Requires future isolated UI or curated trusted review |

Items that cannot be converted to `declarative`:

- Custom JS logic
- React / DOM / Three.js / R3F components
- Timers / event listeners
- Arbitrary `fetch`
- Dynamic asset loading
- Direct `AudioContext`
- `fs` / `net` / `system.exec` / Tauri IPC
- PTY write / terminal prefill equivalents

The basic UX for public distribution is "experiment freely locally → convert to a constrained artifact before publishing." This separation — "authoring is convenient, distribution is restricted" — follows the Figma / VRChat / MetaMask pattern and prevents using it as a backdoor to promote local trusted packs to community trusted.

## Integrity model

A hash alone is not a trust root. If the manifest and bundle are replaced simultaneously, the hash inside the manifest alone cannot detect it.

The public registry treats the following as a single chain:

1. Author publishes the artifact
2. Registry computes the artifact hash
3. Static review / AI quality review / manual review are bound to the hash
4. Registry stores reviewed metadata
5. Install client checks registry reviewed metadata against downloaded artifact hash
6. `pack-lock.json` retains content hash and review ID, not just version

On update, permission diff and hash diff are displayed. Even when auto-update is opt-in, permission increases and execution class changes are never silently updated.

This model depends on the registry being honest or uncompromised. If the registry can tamper with review metadata / hashes / publisher mappings, the client alone cannot achieve full detection.

For MVP, this limitation is stated explicitly, with at minimum:

- Install client pins content hash / review ID / registry metadata snapshot in `pack-lock.json`
- No silent replacement of installed artifacts. Hash diffs are always user-visible
- Packs suspected of registry compromise / rollback can be yanked and disabled operationally

Future hardening candidates:

- Publisher signing key for artifact signatures
- Dual verification with registry signing key + publisher signing key
- Append-only log / transparency log for review metadata
- Client-side gossip / consistency proofs
- Rollback protection and yanked version policy

## MVP recommendations

The following is the implementation order before enabling the currently unavailable public distribution feature.

1. Implement `declarative` first
2. Enable `/charm:prepare-publish` to convert local trusted packs to publishable `declarative` artifacts
3. Share `scripts/check-pack`–equivalent machine checker across CLI / `/charm:prepare-publish` / registry CI
4. Limit public registry to `declarative`. Add curated trusted visuals if operational capacity allows
5. Start `isolated-js` with Web Worker + SES + capability RPC
6. Enable amenity public distribution after `isolated-js` runtime and permission UX are complete

## Review rules

The registry rejects / blocks:

- `executionClass: "declarative"` with `entry` of `.js` / `.mjs` / `.ts` / `.tsx`
- `executionClass: "declarative"` with out-of-schema fields
- `executionClass: "declarative"` containing `__proto__` / `constructor` / `prototype` keys
- `executionClass: "declarative"` containing SVG / CSS `url(...)` / remote URL / `data:` / `file:` / absolute path / traversal
- Community pack with `executionClass: "trusted-main-thread-js"`
- `isolated-js` depending on DOM / Tauri / Node builtins / ambient fetch
- `isolated-js` capability RPC payload exceeding schema / size / depth / rate limit
- Mismatch between declared permissions and code's capability requests
- Hash not matching reviewed metadata
- Attempting to publish a `/charm:create`-origin local `trusted-main-thread-js` pack to community without conversion
- `prepare-publish` machine checker hard rejects remaining
- `system.exec` requiring shell strings
- Requesting PTY write APIs
- Requesting MCP tool calls equivalent to `terminal_prefill` / `write_terminal_input` ([`mcp-trust-tiers.md`](mcp-trust-tiers.md))

## Relationship with self-referential MCP

Charminal plans to implement its own MCP server, exposing all internal capabilities as tools to the inhabitant (AI via Claude Code) and external clients (see [docs/philosophy/PHILOSOPHY.ja.md](../philosophy/PHILOSOPHY.ja.md)).

Pack-execution-classes and this are **different layers**:

- Pack-execution-classes govern **JS execution of distributed packs**. The boundary between host (Charminal) and guest (pack).
- Self-referential MCP governs **the tool surface the Charminal host exposes**. The host runtime's capability surface.

Alignment between the two is defined in [`mcp-trust-tiers.md`](mcp-trust-tiers.md). Trust tiers 1 (host runtime / bundled) / 2 (inhabitant = user's Claude Code) / 3 (external MCP client / community pack) each have per–tool-category access policies.

When a community pack calls MCP tools, it stands at **the intersection of both frameworks**:

- Pack `executionClass` secures the sandbox
- MCP trust tier (Tier 3) gates capabilities
- Defense-in-depth across both runtime and control surface boundaries

Installing external MCP servers follows the same permissions diff / hash chain / review chain as installing community packs. See [`mcp-trust-tiers.md`](mcp-trust-tiers.md) "Connection with pack-execution-classes."

PTY tools (`terminal_prefill` / `write_terminal_input` etc.) are **prohibited across all tiers** for now. They will not be enabled until whitelist validation + length cap + trust tier gate + content-layer social engineering defenses are integrated.

## Related references

- Philosophy: [docs/philosophy/PHILOSOPHY.ja.md](../philosophy/PHILOSOPHY.ja.md) (self-referential MCP concept)
- Related: [`mcp-trust-tiers.md`](mcp-trust-tiers.md), [`critical-constraints.md`](critical-constraints.md), [`explicit-over-implicit-ugc.md`](explicit-over-implicit-ugc.md), [`separate-distinct-systems.md`](separate-distinct-systems.md), [`effect-rendering-primitives.md`](effect-rendering-primitives.md)
- MetaMask Snaps execution environment: <https://docs.metamask.io/snaps/learn/about-snaps/execution-environment/>
- MetaMask Snaps permissions: <https://docs.metamask.io/snaps/how-to/request-permissions/>
- MetaMask Snaps files / `source.shasum`: <https://docs.metamask.io/snaps/learn/about-snaps/files/>
- SES / Endo docs: <https://docs.endojs.org/modules/ses.html>

## Revision history

- 2026-06-13: Added the sandbox declaration capability ladder and Phase 0 fail-closed client contract. Added `pack-sandbox-strategy.md` as the detailed decision.
- 2026-05-16: Added source classification, declarative hostile data checklist, isolated-js initiation gate, capability RPC validation, registry trust limitation, SES bypass defense model, `/charm:create` and publish conversion flow, machine checker relationship, and note that public distribution is not yet available.
- 2026-05-03: Added R3F scene pack class. Initial scope is bundled-only, execution class is `trusted-main-thread-js`.
- 2026-04-24: Initial version. Defined execution classes along three axes (speed / freedom / security), positioned amenity public distribution as future scope after `isolated-js` completion.
- 2026-04-27: Added alignment with self-referential MCP plan. Extended PTY write clause to MCP tools, referenced `mcp-trust-tiers.md` as a new decision. Added terminal_prefill tool request as a registry reject condition.
