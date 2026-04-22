# Codex documentation provenance — UI Pack Plan 2/3

**Date**: 2026-04-22
**Author marker**: Codex session
**Branch / worktree**: `feat/ui-pack-claim` / `/Users/user/Charminal-ui-pack-claim`

This file records which documentation changes in this repo were made by Codex during the UI Pack Plan 2/3 implementation session.

## Codex-authored documentation commits

### `7be8a68 feat(ui-pack): add claim system and three access`

Documentation created or updated by Codex:

- `bundled-packs/README.md`
  - Added `camera-lighting-panel` to the bundled UI pack list.
- `bundled-packs/ui/camera-lighting-panel/README.md`
  - Created the reference UI pack README for camera / lighting controls and claim behavior.
- `src/runtime/README.md`
  - Added `ui-claim-state/` to the runtime module table.
- `src/sdk/ui-pack.d.ts`
  - Updated type-level documentation for `UiContext`, `three`, and `claim`.

### `94765c0 feat(ui-pack): add UI state MCP bridge`

Documentation created or updated by Codex:

- `bundled-packs/README.md`
  - Updated the `camera-lighting-panel` description to include `ctx.state`.
- `bundled-packs/ui/camera-lighting-panel/README.md`
  - Updated the reference README for Plan 3 state keys and MCP read/write usage.
- `src-tauri/README.md`
  - Updated MCP tool descriptions to include `get_ui_state` / `set_ui_state`.
- `src-tauri/resources/charminal-plugin/commands/charm.md`
  - Added user-facing `/charm` command documentation for `get_ui_state` / `set_ui_state`.
- `src/runtime/README.md`
  - Added `ui-state-store/` to the runtime module table.
- `src/sdk/ui-pack.d.ts`
  - Added type-level documentation for `UiStateAPI`.

### `d72b289 fix(ui-pack): scope UI state by pack`

Documentation updated by Codex:

- `bundled-packs/ui/camera-lighting-panel/README.md`
  - Clarified that UI state is scoped per UI pack and `packId` is optional for MCP calls.
- `src-tauri/resources/charminal-plugin/commands/charm.md`
  - Updated MCP examples to show optional `packId`.
- `src/sdk/ui-pack.d.ts`
  - Clarified that `ctx.state` is pack-scoped.

### `142000d docs(ui-pack): clarify pack-scoped state`

Documentation updated by Codex:

- `src/runtime/README.md`
  - Clarified that `ui-state-store/` is pack-scoped and separated by `packId`.
- `src/runtime/ui-state-store/types.ts`
  - Updated runtime type comments to explain that App binds `ctx.state` to the active pack id.
- `src/sdk/ui-pack.d.ts`
  - Removed obsolete “Plan 3 will add state” wording and clarified the Plan 3 shape.

## Related design-record commits

The companion design-record repo (`../Charminal-design-record`) contains the broader design notes. Codex-authored design-record commits from the same session are:

- `653c762 docs: record UI pack Plan 2 claim system`
- `b4ff292 docs: record UI pack Plan 3 state bridge`
- `3c16253 docs: clarify pack-scoped UI state`

See the design-record provenance file there for the exact files and scope.
