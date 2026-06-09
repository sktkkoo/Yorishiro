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
| MCP capabilities | The resident agent controls Charminal through tiered MCP tools; destructive/sensitive capabilities are gated by tier. | [`decisions/mcp-trust-tiers.md`](decisions/mcp-trust-tiers.md) |
| Pack ↔ host (IPC) | The supported authoring surface is the Charminal SDK, not direct Tauri IPC. A non-bundled pack invoking host commands directly, or bypassing the intended capability path, is a vulnerability. | [`../SECURITY.md`](../SECURITY.md), [`decisions/input-prefill-boundary.md`](decisions/input-prefill-boundary.md) |

The conceptual basis for "a pathway existing is what makes a boundary" is the
philosophy doc [`philosophy/PHILOSOPHY.md`](philosophy/PHILOSOPHY.md).

## Attack surface by entry point

- **Malicious pack** — runs as local trusted code in the WebView layer. Bounded by the SDK surface and the PTY-observation-only and IPC boundaries above.
- **MCP client** — bounded by trust tiers. PTY-write-like requests are rejected by design.
- **Local config (`~/.charminal/config.json`)** — user-owned; treated as trusted local input.
- **Local cohabitation state (`~/.charminal/cohabitation.json`)** — user-owned runtime state; treated as trusted local input and kept outside rollback snapshots.
- **Remote input reaching the agent** — relevant when reported issues involve prompt-borne instructions; note the involved vector when reporting.

## Not yet released

Charminal has no public pack registry, in-app community pack installation, or
`/charm:prepare-publish`. These must not be described as released until the pack
checker, review flow, and registry integrity model exist. See
[`SECURITY.md`](../SECURITY.md) "Supported Scope".

## Reporting

See [`SECURITY.md`](../SECURITY.md).
