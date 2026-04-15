# Shared Assets

Pack 間で共有される asset の配置場所。

初回起動時に Charminal がここからユーザーの `$DATA/shared/` にコピーする。
Pack 内のコードは `'vrm:default'`、`'anim:VRMA_wave'`、`'voice:filler_ah'` のような
shared ref で参照する（internal design-record `2026-04-11-design-exploration.md` Section 10.7）。

## Phase 3.5 で配置予定

| directory | 内容 | source |
|---|---|---|
| `animations/` | VRMA files | 旧 repo `~/Documents/Charminal/public/animations/` から流用 |
| `voices/` | pre-recorded WAV | 旧 repo `~/Documents/Charminal/public/voice/` から流用 |
| `bodies/` | VRM models | user が runtime import する（旧 repo に VRM なし） |

現時点では空の placeholder（`.gitkeep`）。
binary asset の git 管理方針は Phase 3.5 で確定する。
