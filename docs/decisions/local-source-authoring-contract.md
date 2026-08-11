# Local source authoring contract

**Status**: active
**Last updated**: 2026-08-12

## TL;DR

Bundled Pack はYorishiro本体のVite buildに参加するが、`~/.yorishiro/packs/`の
local source Packは限定されたruntime compilerを通る。local sourceはPack内の
`.ts` / `.tsx` / `.js` / `.jsx`と明示的なhost moduleだけを使える。Viteの
JSON・`?raw`・asset import、任意npm package、Pack外relative import、raw Tauri
moduleはlocal authoring contractに含めない。

この非対称はsecurity boundaryだけではない。bundled codeはreleaseと一緒に
review・compileされる本体コード、local Packは実行中に読み込むtrusted user code
だからである。local Packはsandboxではない。

## 1. 二つのbuild経路

| 能力 | Bundled Pack | Local user Pack |
|---|---|---|
| Build | repositoryのTypeScript + Vite build | 起動時にWebView上の`esbuild-wasm`でbundle（`.tsx` entryのみ） |
| Entry | repositoryから明示import | `~/.yorishiro/packs/<id>/`を規約名でdiscovery |
| Relative source | Viteが解決できるsource | 同一Pack内の`.tsx`, `.ts`, `.jsx`, `.js` |
| Bare module | repository dependency / alias | 下記host module allowlistのみ |
| JSON import | Vite標準で可 | 非対応 |
| `?raw` import | Vite標準で可 | 非対応 |
| Asset import / `?url` | Vite標準で可 | 非対応。hostの`resolveAsset`を使う |
| Cross-Pack / internal import | 本体実装として技術的に可 | 非対応・非契約 |
| Hot reload | Vite HMR | entryまたは同一Pack内sourceの変更で再bundle・再登録 |

Bundled Packが利用している表現能力は、原則としてstable SDKまたはhost moduleへ
翻訳してlocal Packにも提供する。ただしbundled codeのimport path自体はpublic API
ではない。system-owned settings UI、内部registry、raw Tauri API、Pack間の暗黙な
mutable stateは明示的な例外であり、そのままlocal Packへ公開しない。

## 2. Local entryとsource extension

Local Packのdirectoryはkind-firstではなくflatである。

```text
~/.yorishiro/packs/<pack-id>/
├── manifest.json
├── <kind>.js または対応kindの<kind>.tsx
├── lib/
│   └── helper.ts
└── assets/
    └── model.glb
```

Discoveryが認識するentryは次のとおり。

| Kind | Entry | 備考 |
|---|---|---|
| `effect` | `effect.js` | 事前build済みES module |
| `persona` | `persona.js` | `persona.md`はhostが別途読み込める |
| `amenity` | `amenity.js` | 事前build済みES module |
| `scene` | `scene.js` または `scene.tsx` | 両方ある場合は`.js`を優先 |
| `ui` | `ui.js` または `ui.tsx` | 両方ある場合は`.js`を優先 |
| `ambient-ui` | `ambient-ui.js` または `ambient-ui.tsx` | 両方ある場合は`.js`を優先 |

Runtime source compilerを通るのは`.tsx` entryだけである。そのentryからのrelative
source importは`.tsx`, `.ts`, `.jsx`, `.js`を明示extensionまたはextensionなしで
参照できる。extensionなしの場合はこの順で探索する。directory index import、
`.json`、CSS、WASM、画像、音声、動画、modelはsource moduleとして解決しない。

`.js` entryはBYOC（bring your own compiled JavaScript）経路であり、runtime
compilerのhost bridgeやcontainment検査を受けない。authoring contract上は単一の
事前bundle、または同じPack内だけを参照するbrowser ES moduleとして扱う。別Packや
Yorishiro内部へのrelative importが偶然動いても互換性を保証しない。

## 3. Runtime TSXで使えるhost module

次のbare importだけをhostと同じmodule instanceへbridgeする。

| Import | 用途 |
|---|---|
| `react` | React API |
| `react/jsx-runtime` | automatic JSX runtime（通常はcompilerが生成） |
| `react-dom/client` | DOM root |
| `three` | Three.js |
| `@react-three/fiber` | R3F |
| `@react-three/drei` | Drei helper |
| `@react-three/postprocessing` | R3F post-processing component |
| `postprocessing` | lower-level post-processing primitive |
| `@yorishiro/sdk/controls` | Scene controls |
| `@yorishiro/sdk/r3f` | Yorishiro推奨R3F entry |
| `@yorishiro/sdk/attention-cue` | attention cue component / hook |
| `@yorishiro/sdk` | 型import専用。runtime value exportは提供しない |

型は`import type`で参照する。`leva`、`lucide-react`、`three/addons/*`、
`@tauri-apps/*`、Node builtin、Yorishiroの`src/` path、未記載のnpm packageは
allowlist外である。dependencyをPackに同梱したいという要望は、任意npm importを
開くのではなく、host module昇格・Pack自身への事前bundle・新しい明示dependency
contractのいずれかとして別途判断する。

## 4. Pack境界

`.tsx` entryを含むdirectoryがPack rootになる。`./`と`../`はimport元からPOSIX
normalizationした結果がそのroot内に残る場合だけ許可する。したがって
`lib/view.tsx`から`../theme.ts`は許可し、entryから`../other-pack/scene.tsx`へ
出るimportはcompile errorにする。absolute filesystem path、URL、bare importの
allowlist回避も許可しない。

Shared sourceが必要な場合は次のいずれかを使う。

- stable `@yorishiro/sdk/*` APIへ昇格する
- Packへsourceを複製または事前bundleする
- assetとして各Packに置き、各Packの`resolveAsset`から参照する
- 将来、versionとownershipを持つ明示dependency contractを設計する

Bundled Packのcross-Pack relative importは本体内部の実装detailであり、local
Pack向けの前例ではない。

## 5. JSON・raw text・asset

### JSONとraw text

Local runtime TSXはVite互換loaderではないため、`import data from "./data.json"`と
`import text from "./note.md?raw"`を受け付けない。小さなstatic dataは`.ts` module
のliteralとしてexportする。Personaの`persona.md`だけはPersona loaderが明示的に
読み、`thinking.systemPromptAddition`が未指定なら注入するspecial caseである。

任意のraw file read APIは提供しない。JSON/raw import追加はMIME、size、watch、
error表示、containmentを一体で定義してから行う。

### Asset

Assetはsource importせず、Pack APIが渡すresolverを使う。

- declarative Scene layer: `src: "./assets/background.webp"`
- component Scene: `resolveAsset("./assets/model.glb")`
- Amenity: `ctx.resolveAsset("./assets/sound.mp3")`

Local component Sceneの`resolveAsset`はPack root内だけを`asset://` URLへ変換する。
absolute path、remote/data/file/blob URL、`..` traversalは拒否する。raw Tauri
`convertFileSrc`をPackへ公開しない。Declarative Scene layerでbundle対象になる形式は
`src/runtime/scene-pack-registry/asset-resolver.ts`のallowlistを正本とする。

## 6. Diagnosticsとreload

Authoring時はrepository checkoutから次を実行する。

```bash
npm run check:pack -- ~/.yorishiro/packs/<pack-id>
```

`check:pack`はmanifest、entry存在、unsafe path/URL、forbidden API、symlink、sizeを
検査する。ただしJS/TS scanはheuristicであり、runtime compilerの代わりではない。

Runtime TSX compileではunsupported bare import、Pack外relative import、missing
relative source、source fetch、esbuild diagnosticsをload failureとして記録する。
起動時は失敗したPackだけを`last-startup.json`/Dev Logへ残し、他Packのloadを続行
する。Hot reload失敗時は既存のactive registrationを置き換えない。起動不能時の
safe modeは復旧経路であり、untrusted codeを安全に実行するsandboxではない。

## 7. Version policy

Manifestのversion fieldは役割を分ける。

- `version`: Pack自身のversion。現在のlocal loaderは順序比較しない。
- `yorishiroVersion`: schema上必須の互換range metadata。現在のlocal loaderはrangeを
  評価しないため、これだけを実行可否gateと考えない。
- `minClientVersion`: exact SemVer形式の任意field。指定時はentry import前に現在の
  Yorishiro versionと比較し、古いclientまたはversion取得不能ならfail closed。
- `platform`: `macos`, `windows`, `linux`の任意allowlist。指定時はimport前に現在の
  platformを検証する。

新しいruntime APIが必要なPackは、現行では`yorishiroVersion`に意図するrangeを記し、
実行gateとして対応する`minClientVersion`も指定する。range evaluatorを導入するまで
両fieldを同義に扱わない。

## 8. 保守ルール

Host module、source extension、asset resolver、version gateを変更するときは、
この文書とruntime testsを同じchangeで更新する。Bundled referenceが新しい表現能力を
正式利用した場合は、local authoringへstableに公開できるかを監査し、公開しない場合は
security、host ownership、platform、bundle compatibility、resource riskの具体的理由を
記録する。

## 関連reference

- `src/runtime/user-pack-loader/tsx-transpiler.ts`
- `src/runtime/user-pack-loader/runtime-wire.ts`
- `src/runtime/user-pack-loader/watcher.ts`
- `src/runtime/user-pack-loader/pack-execution-policy.ts`
- `src/runtime/scene-pack-registry/asset-resolver-pack.ts`
- `src-tauri/src/lib.rs` (`list_user_packs` / manifest summary)
- [`user-pack-layout.md`](user-pack-layout.md)
- [`pack-execution-classes.md`](pack-execution-classes.md)
- [`bundled-pack-immutability.md`](bundled-pack-immutability.md)
