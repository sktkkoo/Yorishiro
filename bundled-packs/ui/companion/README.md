# companion

terminal、chrome、tab indicator を隠し、住人の stage だけを window 全体へ広げる。native
window の最小サイズを 320x420 logical px へ下げ、起動時に最小幅の 320x720 へ自動で縮める。
他の UI へ切り替えると、companion に入る直前の window size を復元する。有効な間は window を
always-on-top にする。

`theater` 用の stage transition は使わない。native window resize と fullscreen stage animation を
同時に走らせると、resize 前の viewport 幅を基準に camera が動いたあと新しい幅へ snap するため。

`theater` は Yorishiro の通常 window 内で住人を全画面表示する。`companion` は terminal と chrome を
隠し、細い window で表示する。

## 開く・閉じる

- runtime のみ: MCP `ui.activate({ id: "companion" })`
- 永続選択: `~/.yorishiro/config.json` の `activeUi` を `"companion"` にする
- 閉じる: 別 UI pack へ切り替えるか、active UI を `null` にする

解除時は host default の最小サイズ 900x600、always-on-top=false へ戻る。

現段階では window 背景を透過しない。完全な desktop overlay 化は native window の透明化と
click-through の設計を別段階で追加する。
