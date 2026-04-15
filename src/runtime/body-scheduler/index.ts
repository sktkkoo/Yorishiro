/**
 * BodyScheduler — 複数 persona の handler が同じ body に届いたとき motion collision を resolve する internal unit。policy は post-MVP で確定
 *
 * Philosophy: internal design-record 2026-04-11-design-exploration.md Section 7.2「Body scheduler の衝突解決 policy」（deferred decision）
 * SDK surface: src/sdk/context.d.ts の CharacterAPI の背後で働く internal service
 *
 * 本 skeleton は Phase 3.3(g.1) で配置。real 実装は post-MVP で TDD 予定。
 */
export class BodyScheduler {}
