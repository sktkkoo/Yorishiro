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
