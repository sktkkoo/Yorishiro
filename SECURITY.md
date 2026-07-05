# Security Policy

For the trust-boundary and attack-surface map, see [`docs/security.md`](docs/security.md).

## Supported Scope

Yorishiro is still pre-1.0. Security fixes target the current `main` branch and the latest public release when one is available.

User-created packs in `~/.yorishiro/packs/` are treated as local trusted code. They are not sandboxed, not reviewed by Yorishiro, and not equivalent to a public-registry artifact.

Yorishiro does not currently provide a public pack registry, in-app community pack installation, or `/yori:prepare-publish`. Those features must not be described as released until the pack checker, review flow, and registry integrity model are implemented.

## Reporting a Vulnerability

Please report vulnerabilities privately by opening a GitHub security advisory.

Include:

- affected version or commit
- operating system
- reproduction steps
- expected impact
- whether a malicious pack, local config, MCP client, or remote input is involved

## Pack Security Boundary

Packs created by `/yori:create` are local authoring packs. Sharing their source code on GitHub or elsewhere is allowed, but anyone installing them manually is choosing to run local trusted code.

Do not present such packs as sandboxed, reviewed, or safe for Yorishiro public distribution. A future publish flow will require constrained artifacts, machine checks, registry review, and integrity metadata before in-app community installation is enabled.

Pack execution classes and future distribution constraints are documented in [`docs/decisions/pack-execution-classes.md`](docs/decisions/pack-execution-classes.md).

## MCP, PTY, and IPC Boundary

Yorishiro includes a local MCP server (loopback `127.0.0.1` only) for letting the resident agent control Yorishiro features. The *intended* MCP capability boundaries are documented in [`docs/decisions/mcp-trust-tiers.md`](docs/decisions/mcp-trust-tiers.md). Note that trust-tier gating (caller identification, per-tier approval, audit log, rate limit) is **not yet implemented**; the current enforcement status is summarized in [`docs/security.md`](docs/security.md) "Current enforcement status".

MCP and pack pathways are observation-oriented with respect to the terminal. No PTY write-like capability is exposed as an MCP tool; `terminal_prefill` / `write_terminal_input` style behavior is treated as security-sensitive and is not implemented for any tier.

Yorishiro is a Tauri app with a TypeScript WebView layer and a Rust host layer. The Yorishiro SDK is the *supported* pack authoring surface, but it is not a runtime-enforced sandbox: a user pack runs in the same WebView realm as the app and can reach Tauri IPC commands directly (this is the "local trusted code" stance — installing a pack runs code with your own authority). Reaching host IPC directly becomes a reportable vulnerability once packs are sandboxed for in-app community distribution (the future `isolated-js` execution class). Until then, treat installing any pack as running fully-trusted local code with full system access.
