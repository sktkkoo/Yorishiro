# Contributing to Yorishiro

> [日本語版 CONTRIBUTING はこちら](CONTRIBUTING.ja.md)

## Contribution Policy

**Issues and Discussions are very welcome — right now they are the most valuable way to contribute.** A single line is enough, you do not need to fill a template perfectly, and English and Japanese are both fine.

- **Bug reports** — please use the [Issue templates](.github/ISSUE_TEMPLATE/)
- **Feature requests and proposals** — feel free to open an Issue, even half-formed ones
- **Questions, impressions, and packs you made** — please use [Discussions](https://github.com/sktkkoo/Yorishiro/discussions)
- **Security reports** — see [SECURITY.md](SECURITY.md)

Small, self-contained bug fixes, tests, documentation, and platform compatibility fixes may be submitted directly as Pull Requests. Link a related Issue when one exists; an Issue is not required for every small change.

For substantial changes to the Pack API, security, permissions, IPC, provenance, sandboxing, or architecture, discuss the design in an Issue before implementation. Use the [PR template](.github/pull_request_template.md) to explain scope and verification, and consult the [review routing and Pack checklist](docs/contributor-review.md).

Accepting source-code PRs does not enable or certify community Pack installation. Local packs remain trusted code; see [SECURITY.md](SECURITY.md).

### Compatibility before 1.0

The supported authoring surface is documented in [`src/sdk/README.md`](src/sdk/README.md). The Pack API is not frozen at 1.0 compatibility. Changes to supported behavior must describe compatibility impact, document migration when needed, and include appropriate regression coverage. An undocumented internal API is not a supported extension contract.

### Extension via Packs

Many "I want this feature" or "I want to change the look" requests can be realized without touching the core, through **Packs**. See [`src/sdk/README.md`](src/sdk/README.md) for how to write one. You can also create a pack conversationally with the `/yori:create` command.

## License

Yorishiro is released under the [MIT License](LICENSE).

Code submitted in a Pull Request is offered under the same MIT License.

## For Developers

For local builds and development, see [DEVELOPMENT.md](DEVELOPMENT.md).
