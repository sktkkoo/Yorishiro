# Security Overview

This is a map of Charminal's trust boundaries and attack surface. It does not
define rules — each boundary's normative definition lives in the linked
document. For how to report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

Charminal is a Tauri app: a TypeScript WebView layer over a Rust host layer. An
AI agent runs in an embedded terminal and can drive the app through a local MCP
server. Users and AI can extend nearly everything through *packs*.

## Trust boundaries

| Boundary | Stance | Normative source |
|---|---|---|
| Terminal (PTY) | Observation only. No pack/MCP API can write arbitrary text to the PTY; `terminal_prefill` / `write_terminal_input` style behavior is treated as security-sensitive. Packs reach the input only through host-owned fixed-prompt verbs and the user-gesture-gated reference marker. | [`decisions/critical-constraints.md`](decisions/critical-constraints.md), [`decisions/input-prefill-boundary.md`](decisions/input-prefill-boundary.md), philosophy `PHILOSOPHY.md` |
| User packs (`~/.charminal/packs/`) | Local trusted code. Not sandboxed, not reviewed, not a public-registry artifact. Installing a shared pack manually = choosing to run local trusted code. | [`decisions/pack-execution-classes.md`](decisions/pack-execution-classes.md), [`decisions/scene-execution-sandbox.md`](decisions/scene-execution-sandbox.md) |
| Bundled packs | Part of the app, immutable from within Charminal. | [`decisions/pack-execution-classes.md`](decisions/pack-execution-classes.md) |
| MCP capabilities | *Intended:* the resident agent controls Charminal through tiered MCP tools, with destructive/sensitive capabilities gated by tier. **Tier gating is not yet implemented** (see "Current enforcement status" below). | [`decisions/mcp-trust-tiers.md`](decisions/mcp-trust-tiers.md) |
| Pack ↔ host (IPC) | The Charminal SDK is the *supported* authoring surface, but it is not a runtime-enforced sandbox: a local pack shares the host realm and can reach Tauri IPC directly. A pack reaching host IPC directly is a vulnerability only once packs are sandboxed (future community / `isolated-js` class); for today's local trusted packs it is not prevented. See "Current enforcement status". | [`../SECURITY.md`](../SECURITY.md), [`decisions/input-prefill-boundary.md`](decisions/input-prefill-boundary.md) |

The conceptual basis for "a pathway existing is what makes a boundary" is the
philosophy doc [`philosophy/PHILOSOPHY.md`](philosophy/PHILOSOPHY.md).

## Attack surface by entry point

- **Malicious pack** — runs as local trusted code in the same WebView realm as the app. It is **not** sandboxed by the SDK: it can call any Tauri IPC command directly (including `system_exec`). The only boundary is provenance — you chose to install it, as with a shell script or an editor extension. The PTY observation-only boundary holds at the type level, but a pack can still reach `pty_write` via raw IPC; see "Current enforcement status".
- **MCP client** — PTY-write-like requests are rejected by design (no such tool exists). Other implemented tools are **not yet tier-gated** and are reachable by any local process; see "Current enforcement status".
- **Local config (`~/.charminal/config.json`)** — user-owned; treated as trusted local input.
- **Local cohabitation state (`~/.charminal/cohabitation.json`)** — user-owned runtime state; treated as trusted local input and kept outside rollback snapshots.
- **Remote input reaching the agent** — relevant when reported issues involve prompt-borne instructions; note the involved vector when reporting.

## Current enforcement status (pre-1.0)

The table above describes *intended* boundaries. Several are provenance/social
boundaries today, not runtime-enforced ones. Know what is actually enforced
before relying on any of them:

- **PTY observation-only — enforced at the type/API level.** No MCP tool writes
  to the PTY, and the SDK exposes no arbitrary-text input verb (only host-owned
  fixed-prompt verbs and the user-gesture-gated reference marker). This holds
  against MCP clients. In-realm pack code can still reach `pty_write` via raw
  IPC — see the next point.
- **User packs share the host realm — the SDK is not a sandbox.** User and
  bundled packs run in the same WebView realm as the app and can reach every
  Tauri IPC command directly through `window.__TAURI_INTERNALS__`, including
  `system_exec` (arbitrary `sh -c`). The SDK (`ctx.*`) is the *supported*
  authoring surface, not an *enforced* one. This is consistent with the "local
  trusted code" stance: installing a pack runs code with the same authority as
  your shell. Runtime isolation arrives only with the unimplemented
  `isolated-js` class for future community packs.
- **MCP trust tiers are not yet implemented.** The local MCP server
  (`127.0.0.1`, loopback only) has no caller identification, no per-tier
  approval, no audit log, and no rate limit. The implemented tools
  (`list_packs`, `enable_pack`, `disable_pack`) are reachable by any process
  running as the same user. `enable_pack` / `disable_pack` mutate `config.json`
  without an approval prompt; the change is reversible (re-enable + history
  snapshots). Tracked in [`decisions/mcp-trust-tiers.md`](decisions/mcp-trust-tiers.md)
  "Implementation status".
- **No outbound network.** The Rust host has no HTTP client. Screenshots and TTS
  are produced locally and never leave the machine, and CSP `connect-src`
  permits no external origin.

These gaps are acceptable for a single-user local desktop app pre-1.0, but must
be closed before any in-app community pack installation or multi-machine MCP
pairing is enabled.

## Not yet released

Charminal has no public pack registry, in-app community pack installation, or
`/charm:prepare-publish`. These must not be described as released until the pack
checker, review flow, and registry integrity model exist. See
[`SECURITY.md`](../SECURITY.md) "Supported Scope".

## Reporting

See [`SECURITY.md`](../SECURITY.md).
