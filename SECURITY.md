# Security Policy

## Supported Scope

Charminal is still pre-1.0. Security fixes target the current `main` branch and the latest public release when one is available.

User-created packs in `~/.charminal/packs/` are treated as local trusted code. They are not sandboxed, not reviewed by Charminal, and not equivalent to a public-registry artifact.

Charminal does not currently provide a public pack registry, in-app community pack installation, or `/charm:prepare-publish`. Those features must not be described as released until the pack checker, review flow, and registry integrity model are implemented.

## Reporting a Vulnerability

Please report vulnerabilities privately by opening a GitHub security advisory.

Before the OSS announcement, add a dedicated security contact email here.

Include:

- affected version or commit
- operating system
- reproduction steps
- expected impact
- whether a malicious pack, local config, MCP client, or remote input is involved

## Pack Security Boundary

Packs created by `/charm:create` are local authoring packs. Sharing their source code on GitHub or elsewhere is allowed, but anyone installing them manually is choosing to run local trusted code.

Do not present such packs as sandboxed, reviewed, or safe for Charminal public distribution. A future publish flow will require constrained artifacts, machine checks, registry review, and integrity metadata before in-app community installation is enabled.

Pack execution classes and future distribution constraints are documented in [`docs/decisions/pack-execution-classes.md`](docs/decisions/pack-execution-classes.md).

## MCP, PTY, and IPC Boundary

Charminal includes a local MCP server for letting the resident agent control Charminal features. MCP capability boundaries are documented in [`docs/decisions/mcp-trust-tiers.md`](docs/decisions/mcp-trust-tiers.md).

MCP and pack pathways are observation-oriented with respect to the terminal. PTY write-like capabilities are intentionally not exposed as pack or community MCP APIs, and requests for `terminal_prefill` / `write_terminal_input` style behavior are treated as security-sensitive.

Charminal is a Tauri app with a TypeScript WebView layer and a Rust host layer. The supported pack authoring surface is the Charminal SDK, not direct Tauri IPC. If a non-bundled pack can invoke host commands directly, or bypass the intended capability path, report it as a vulnerability.
