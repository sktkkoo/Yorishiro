# Contributor review guide

Small, self-contained fixes may be submitted directly. Substantial Pack API,
security, permission, IPC, provenance, sandbox, or architecture changes need an
Issue/design discussion first. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the
contribution and pre-1.0 compatibility policy.

## Review routing

The repository maintainer owns final acceptance and routes reviews according to
the affected boundary. A contributor should identify the relevant rows below in
the PR; this is not a claim that a separate reviewer team exists.

| Area / paths | Review focus |
| --- | --- |
| `src/sdk/`, SDK examples, `src/sdk/vendor/` | Supported contracts, types, schema, examples, migration and conformance tests |
| `src/runtime/` Pack loaders and registries, `src/bundled-packs.ts`, `src/ui-pack-activation.ts` | Lifecycle, replacement/cleanup, resource ownership, trusted local code assumptions |
| `src-tauri/src/mcp/`, host commands in `src-tauri/src/`, `src-tauri/capabilities/` | Caller inputs, authority, filesystem/network/terminal effects, exposed host capabilities |
| Provenance, loading, install, integrity, sandbox, or permission code anywhere | Cross-layer threat model, failure behavior, distinction between implemented controls and plans |
| `.github/workflows/`, release scripts, dependencies | Untrusted PR execution, credentials, supply-chain impact, reproducibility |
| `SECURITY.md`, `docs/security.md`, Pack security decisions | Agreement between public claims and current enforcement |

The maintainer should request boundary-focused review before accepting sensitive
changes. These routes describe review responsibility, not automatic GitHub
approval enforcement. No `CODEOWNERS` or branch-protection rule is introduced by
this document. Required checks/reviews can be configured later when useful; they
are not prerequisites for opening source-code PR intake.

## Pack API and security checklist

Use the applicable items; a small documentation fix does not need a security essay.

- Name the supported SDK surface affected. Update declarations, schema, examples,
  and docs together where relevant. Document breaking behavior and migration;
  pre-1.0 does not mean silent compatibility changes are acceptable.
- Identify the caller and input origin: app, trusted local Pack, MCP client, or
  remote/untrusted content. Explain which authority can cross the boundary.
- Identify filesystem, network, process/terminal, credentials, and private-memory
  access introduced or expanded. Check validation and permission enforcement at
  the host boundary, not only in UI types.
- Describe failure and cleanup behavior, including denied inputs, path aliases,
  replacement/disposal, and partial execution when relevant. Add regression tests
  for changed behavior and important denied cases.
- Keep local trusted Pack authoring distinct from community distribution. Source
  review does not make a Pack sandboxed or approved for in-app installation.
- Do not claim planned `isolated-js`, provenance/signature enforcement, MCP trust
  tiers, public Pack Store, or version-range enforcement is implemented. Update
  [the security map](security.md) when actual enforcement changes.
- Report the checks run, any unavailable platform/live verification, and the
  remaining uncertainty. Follow [SECURITY.md](../SECURITY.md) for private reports
  of vulnerabilities; do not publish sensitive reproductions in a normal Issue.

See [Pack authoring parity](decisions/pack-authoring-capability-parity.md),
[execution classes](decisions/pack-execution-classes.md), and
[MCP trust tiers](decisions/mcp-trust-tiers.md) for the current design boundaries.

## Existing pull-request CI

[The CI workflow](../.github/workflows/ci.yml) runs on Pull Requests targeting
`main`, as well as pushes to `main` and manual dispatch. Its current jobs are:

| Job | Checks |
| --- | --- |
| `continuity-observation` | Read-only autonomous-run observation script tests |
| `check` | Runtime/build preparation, TypeScript, Biome, Rust formatting and Clippy via `npm run check` |
| `test` | Pi worker/harness/provider and package tests, TypeScript tests, and Rust tests |

The workflow uses `pull_request`, not privileged `pull_request_target`, and its
test path installs fixture dependencies without provider calls. Do not add
secrets or publishing steps to execute untrusted contributor code. Local
[development checks](../DEVELOPMENT.md#linting--formatting) and the existing
pre-push gate remain applicable. A green CI result supplements review; it does
not certify Pack distribution or physical audio/visual behavior.
