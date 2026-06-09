# Persona の multi-instance 運用

> このファイルは「**persona の active 数 / 切り替え / 並行運用で設計判断する**」時に読む。対象：dev / AI / pack 作者。

**Status**: superseded（旧設計を MVP 実装段階で修正） / active（現行：single-active）
**Last updated**: 2026-04-19

## TL;DR

**複数 persona を同時に active にする運用は、Charminal の architecture では実現不可能**。Claude Code の additive system prompt 注入は **起動時 1 回のみ** で、session 内で persona を差し替えられない。**single-active persona registry**（user pack が bundled を override）が現行の正解。

---

## 何を決めたか

- **PersonaRegistry は single-active**。同時に複数 persona を active にしない
- active 選択は `~/.charminal/config.json` の設定 + user-over-bundled override の自動 promotion で決まる
- persona switch は **新しい Claude Code session を起動する** ことで行う（session 内動的 switch は不可）
- 内部実装：`src/runtime/persona-registry/persona-registry-impl.ts:PersonaRegistryImpl`（reference 比較で listener fire、user dispose 時の auto-select 抑止フラグあり）
- 関連 commit：`39289df feat(persona-registry): single-active registry with user-over-bundled override`

---

## なぜそう決めたか

### 一次的な制約（technical）

Claude Code（Anthropic 公式 CLI）の system prompt は、起動時に `--system-prompt-addition` で **additive** に渡される。**session が走っている間に追加 / 差し替える API は存在しない**。Charminal は Claude Code の thinking layer に persona を注入するため、persona = system prompt 注入。よって：

- **session 起動時に persona = 1 個確定**
- **session 寿命中の動的 persona switch ≒ Claude Code の再起動が必要**

### 二次的な含意（design）

ここから follow する制約：

- 「user が会話の途中で persona を切り替える」体験は physically 不可能
- Charminal が「内部に複数 persona instance を保持して dispatch する」runtime model を持つ意味はほぼない（active な 1 個以外は dead weight）
- 複数 persona の motion 衝突を解決する `BodyScheduler` という primitive の存在意義は **MVP では薄い**（衝突する相手がいない）

### Resolution（current architecture）

- **Registry は複数 persona を保持できる**（user / bundled の両方を register する場面はある）
- **active として外に export されるのは常に 1 個**
- override semantics：user pack が同 id で bundled を override すると、active が user 側に promote される
- BodyScheduler は skeleton のまま deferred（post-MVP、policy も未決定）

---

## 検討したが却下した代替案

### A. 複数 persona 並行 active

**初期 design intent**（「Charminal は複数 persona を持つ単一個体」という構想、および初期実装での「複数 persona 並行前提の internal model」）。

**却下理由**：
- system prompt 注入が起動時 1 回のみ → 複数 persona の "thinking layer" を同時に持てない
- thinking layer に住んでない persona は「色付けだけする persona」になり、概念的に半端

### B. session 内 persona switch（動的）

**却下理由**：
- 同上。Claude Code の制約により thinking layer 側の persona を switch できない
- 「reflex / 身体だけ switch する」は thinking layer との一致が崩れて誠実さの原則に反する

### C. session 起動 → persona 確定 → 別 persona 試したい時は新 session

**採用**。これが現行。**user 側の barrier は「Claude Code を一度落として上げ直す」だけ**で受容範囲。

---

## この決定の implication / 制約

### MVP scope への影響

- **PersonaRegistry** は single-active semantics で十分（複雑な multi-active dispatch は不要）
- **BodyScheduler** は post-MVP に完全 defer（衝突相手不在）
- **Persona switching UI** は design 時に「session 起動時に選ぶ」前提で組む（mid-session switch UI は作らない）

### Pack system への影響

- 複数 persona pack を同時に install するのは可能（registry に並ぶ）
- 「どれを active にするか」は config の `activePersona`（または同様の field）で user が picks
- これは scene pack の `activeScene` semantics（[single-active-config-picks.md](single-active-config-picks.md) 参照）と同じ pattern

### 思想層への影響（注意）

- **「Charminal は多人格の meta-identity」というナラティブ自体は維持できる**：「複数の persona を持つが、ある瞬間に外に出ているのは 1 人」と解釈すれば philosophy/PHILOSOPHY.ja.md「多人格の住人」と整合する
- **「session 越しに persona memory が異なる」という持続性**：これは可能。session A は kurai persona、session B は別 persona、それぞれが core memory を共有する model
- ただし「**同時に複数の人格が並行して喋る**」という interpretation は技術的にも哲学的にも採らない

### Future work の余地

- Claude Code が将来的に dynamic system prompt を支援した場合は再検討余地あり
- それまでは single-active 前提で primitive を磨く

---

## 関連 reference

### Philosophy

- [docs/philosophy/PHILOSOPHY.ja.md](../philosophy/PHILOSOPHY.ja.md)「多人格の住人」section
- [docs/philosophy/PHILOSOPHY.ja.md](../philosophy/PHILOSOPHY.ja.md) 「多人格の住人」section

### Source

- `src/runtime/persona-registry/persona-registry-impl.ts:PersonaRegistryImpl` — single-active 実装
- `src/runtime/persona-registry/select-active.ts:computeActivePersona` — active 選択 logic

---

## 改訂履歴

- 2026-04-17: 旧設計「複数 persona 並行前提」が初期実装に記録
- 2026-04-19 commit `e0a84f9`: PersonaPackManifest sdk 追加
- 2026-04-19 commit `39289df`: single-active registry に修正（current）
- 2026-04-19 doc 化: 本ファイル作成（「複数運用は現実的でない」が明確になったことを契機）
