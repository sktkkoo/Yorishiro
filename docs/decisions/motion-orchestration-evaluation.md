# Recorded motion orchestration and comparative evaluation

**Status**: implementation guidance; comparison with Animates pending  
**Last updated**: 2026-09-14

2026-09-14 update: the [quality strategy](motion-quality-strategy.md) supersedes an Idle-only interpretation of the comparison. The user's Animates example includes expressive conversational arms and dancing in time with music playing on the PC. Music detection/dancing is a reference for contextual timing and full-body quality, not the first required Yorishiro feature. Prioritize original-recording fidelity and Idle/listening/conversation handoffs before extending feature count.

## Goal and scope

Yorishiro の自然さと実在感を、収録済みの複数モーションを自然につなぐことで改善する。ユーザーの希望により、主役は収録済みモーションとする。procedural な呼吸・視線・補正は小さな補助であり、clip の代わりに大きな身体動作を生成しない。追加の有料 API や常駐 vector database を必須にしない。

Animates を明確に上回るという達成条件は、実装や単体テストだけでは満たされない。実アプリとの比較を実施し、後述の判定基準を満たすまでは **unverified** と記録する。存在しない比較データを baseline として生成しない。

## Public evidence and unknowns

[Animates の公式サイト](https://animates.ai/) は life companion と presence を訴求している。[運営 Animation Inc.](https://www.animation.inc/) は Ani-2 を proprietary / on-device / full-body / real-time なモデルと説明し、2.5 ms/frame の推論速度を公称する。この数値は独立測定ではなく、レンダリングや会話全体の遅延でもない。これを Yorishiro のフレーム時間と直接比較しない。

公開情報だけでは、接地品質、遷移時の速度連続性、長時間 idle の反復率、会話割り込みへの反応を同条件で評価できない。公開ページ内のサンプルコードも、利用可能な SDK 仕様や実アプリの実装を証明するものではない。

2026-09-13 に親タスクが `/Applications` 内の Animates 1.0.8 build 24 を確認した。CUA は `CUA_REPL_ENABLED_SURFACES is required` で利用できなかった。その後、native window に限定した静止画 20 枚を取得し、以下の限定的な待機時観察を実施した。低頻度の連写による観察と、連続動作の比較評価は別々に扱う。

## Technical decision

提案する流れは「文脈から収録モーション候補を検索 → 身体的に接続できる候補へ絞る → 反復と継続時間を考慮して選択 → 適切な出入口で切り替える → 遷移だけを補正する」。以下は一次資料を踏まえた設計上の判断であり、Animates に対する実測上の優位性ではない。

- **意味と接続可能性を分ける。** 意図・感情・強度・活動状態を検索条件にし、その後に姿勢・速度・接地を評価する。意味の近い上位 5 件でも、その瞬間の身体には接続できないことがある。候補数を満たすために関連度や遷移品質の閾値を下げない。候補がなければ自然な継続を許容する。
- **出側と入側を対で評価する。** 低速フレーム単独では安全な切れ目を保証しない。左右支持脚、足位置、腕の向き、角速度、hip の変化を含める。準備・主動作・戻りという演技のまとまりを途中で切らない。
- **慣性補間は遷移時に使う。** 姿勢差と速度差を捕捉し、短時間で消失させる。常時の低域フィルターは反応遅延と元の演技の変形を招く。quaternion の最短経路、正規化、可変 delta、割り込み中の再遷移を検証する。
- **接地は候補選別と最終補正の両方で扱う。** ワールド空間の足先速度・床高から接地区間を推定する。root translation の一律削除も接地を変えるため、元のデータと再生時の変形を区別して測る。必要な foot lock には解除距離・解除条件を設ける。
- **持続と間を保つ。** 最低継続時間、直近使用履歴、繰り返しペナルティ、感情の減衰を持つ。テキストの断片ごとに大きな演技へ切り替えない。発話タイミングが取れる場合は主動作を意味のある語に合わせる。
- **ローカル検索を基本にする。** 少数から数百 clip の段階では配列と特徴量の検索で足りる。ローカル埋め込みは任意拡張にできる。辞書・手動タグ・ユーザーの明示 cue でも動作する経路を維持する。

## Primary sources

| Source | What it supports | Limitation / integration note |
| --- | --- | --- |
| [Bollo, Inertialization, GDC 2018](https://media.gdcvault.com/gdc2018/presentations/bollo_david_inertialization_high_performance.pdf) | 遷移時の姿勢・速度差を後処理で消失させ、運動の連続性を保つ。常時フィルターとの違いを説明。 | 遷移だけで接地や意味整合性が自動的に解決するわけではない。 |
| [Ponton et al., Combining Motion Matching and Orientation Prediction, 2022](https://onlinelibrary.wiley.com/doi/10.1111/cgf.14628) | 姿勢、速度、接地を記録した motion database と、足速度からの contact 判定・foot lock。 | locomotion / VR を対象とする。会話 idle への効果は独自に検証する。 |
| [Zhou et al., GestureMaster, 2022](https://ailab.netease.com/paper/GestureMaster_Graph-based_Speech-driven_Gesture_Generation.pdf) | リズム、スタイル、遷移を評価して収録済みモーションを連結する実例。 | 元論文の評価は Yorishiro や Animates の評価ではない。 |
| [GENEA 2022 evaluation, TOG 2024](https://doi.org/10.1145/3656374) | 自然さと発話への適切さを分けた大規模評価。高品質な playback-based 手法の有効性。多くの客観指標が主観的自然さと十分対応しない。 | 特定データ・共通モデル・共通レンダラーでの結果。製品間比較へ数値を流用しない。 |
| [Semantic Gesticulator official implementation](https://github.com/LuMen-ze/Semantic-Gesticulator-Official) | 意味ジェスチャー検索とリズム動作を分離・統合する方式。コードには localhost の OpenAI 互換 LLM 接続がある。 | モデル、データ、計算資源、ライセンスは個別評価が必要。現実装への必須依存にはしない。 |
| [Holden, Motion Matching implementation](https://github.com/orangeduck/Motion-Matching) | motion matching と慣性補間の参照実装。コードは MIT。 | 付属データはコードと別の CC BY-NC-ND。アプリのモーション資産として無条件に再配布しない。 |
| [GENEA 2023 evaluation](https://arxiv.org/abs/2308.12646) | 動きの人間らしさ、本人の発話への適切さ、相手の振る舞いへの適切さを分ける評価設計。 | 実在感という製品全体の構成概念を単独で測るものではない。 |

## Reproducible comparison protocol

### Conditions and recordings

比較条件を、A: 既存 Yorishiro、B: 意味検索上位 5 件から重み付きランダム、C: 今回方式、D: Animates の実アプリ、とする。A/B/C は同じ VRM、同じ収録資産、カメラ、照明、フレームレート、音声、発話を使う。収録資産やモデルを変えた場合は別の比較として記録する。

D についてはバージョン、ビルド、OS、ハードウェア、モデル、会話入力、録画日時を記録する。長時間動作や失敗を編集で除外しない。公開宣伝動画と、任意条件で実行した C をそのまま同条件の比較としない。

最低限のシナリオ：

1. 無言の idle を 5 分継続する。
2. 相手が話している間に聞く。
3. 考えてから短く答える。
4. 長い説明を行う。
5. 同意と否定をそれぞれ示す。
6. 喜びから平静へ戻る。
7. 発話中に相手が割り込む。
8. 連続する発話の後、作業や静かな待機へ移る。

各シナリオを複数 seed / 複数試行で記録し、都合のよい試行を選別しない。clip manifest、資産 SHA-256、seed、設定、実際の選択ログ、実測フレーム時刻を保存する。評価対象の一部は調整に使わない held-out シナリオにする。

### Separate judgments

- **動きの自然さ**: 無音動画で、切り替え、接地、重心、身体の連動、反復を評価する。
- **文脈への適切さ**: 発話付き動画で、意味と主動作の時刻、相手の発話への反応、過剰な演技を評価する。同じ方式の適合 / 不適合な発話との組み合わせも入れ、滑らかさの印象が意味整合性を代替していないか確認する。
- **実在感への寄与**: 会話全体で、注意の向き、持続する状態、間、相互反応から、そこにいるように感じるかを評価する。

製品名を伏せて表示順・左右を無作為化する。各評価者が複数条件を見る。評価者単位の集計または評価者を考慮したモデルを用い、同じ評価者の大量クリックを独立した人として数えない。小規模 pilot で質問と収録条件を検証した後、必要人数を定める。任意の人数で十分な検出力があると事前に決めつけない。

### Proposed acceptance criteria

本評価前に固定する暫定基準は、C 対 D の **自然さと実在感の両方で C の選好率が 60% 以上、かつ評価者単位で算出した 95% 信頼区間の下限が 50% を超えること**。文脈適合性の悪化がないことも確認する。閾値、除外規則、比較回数を結果を見て変更しない。multiple comparison がある場合はそれを考慮する。

Animates と同じ avatar や音声を使えない場合は外見と音声が交絡する。D との評価で言える範囲は「この条件の製品体験としての優位」であり、「モーションシステム単体の優位」とは分ける。単体の寄与は同一 avatar の A/B/C と、C の各機構を外した ablation で検証する。

### Diagnostics, not substitutes for people

接地中の足移動、遷移時の速度跳躍、角速度・加速度の外れ値、反復率、割り込み反応遅延、処理時間 p95 を原因分析と退行検知に使う。低い jerk や大きい動きの種類数だけで自然さや実在感が高いと結論しない。contact が速度閾値で推定された場合、その条件で足滑りが小さいことは独立した精度検証にならない。

## Evidence status

### Animates window-only observations, 2026-09-13

Animates 1.0.8 build 24 の対象ウィンドウだけを、約 1.5 秒おきに 20 枚、約 30 秒間取得した。元 PNG はすべて 670 × 1248 pixels。ローカルの `/private/tmp/yorishiro-animates-window-sequence/000.png` から `019.png` に保管し、5 列 × 4 行の montage にして左上から番号順に目視した。元画像や派生 montage は私有アプリの表示であるためリポジトリにはコピーしていない。入力や会話の同期記録はなく、ここでは表示上の待機姿勢の観察として扱う。

20 枚とも腕を下ろした立位を維持している。頭、上体、腰には小さな位置・傾きの違いがあり、視線と眼の開きにも変化が見られる。`012` は閉眼を示し、`000` / `007` / `010` / `016` / `019` では眼の開きが小さい。手を大きく上げる、指差す、胴体を大きく回すといったポーズは、この標本中には見られない。複数画像で似た立位へ戻っているが、同じ clip のループと断定できる周期的反復は確認できない。

足首と足は全画像で画角外のため、接地、足滑り、足の踏み替えは評価できない。1.5 秒間隔ではその間の短いジェスチャーや瞬きが欠落するため、連続速度、加速度、滑らかさ、遷移の不連続、瞬き回数、反復周期も測定できない。眼の開きの違いだけから疲労や感情を推定しない。この観察からは「この約 30 秒では、立位を保ちながら頭・上体・眼に変化がある」という範囲に限って記述する。Yorishiro の自然さ・実在感の優越は引き続き未判定。

### Recorded asset audit, 2026-09-13

再現コマンドは `node scripts/analyze-motion-assets.mjs`。既定では sibling の `Yorishiro-assets/animations` にある 29 VRMA と `models/Yori.vrm` を読み、[motion-assets-analysis.json](motion-assets-analysis.json) を出力する。第 1 引数で asset root、第 2 引数で出力先を指定できる。資産そのものは変更しない。

スクリプトは公式 `VRMAnimationLoaderPlugin` で回転を正規化し、Yori の normalized humanoid 骨格で 60 Hz の FK を行う。主要 22 bone の角速度、足先位置、末尾と先頭の差、静かな 2 秒区間を測定する。各 clip の 4 時刻、計 116 姿勢を公式 `createVRMAnimationClip` + `THREE.AnimationMixer` と照合し、足先位置差 0.1 mm 未満・局所回転差 0.01° 未満の検証に全件合格した。JSON の誤差表示精度ではすべて 0。

以下は再生速度 1、weight 1、hip translation 除去、procedural 無しの値。現在の製品で実際に使う weight / speed / 下半身マスク / 補正を含む値とは区別する。「足先速度」は接地中だけの足滑りではなく、動作全体の足指 bone の速度である。

| Clip | 全身角速度 RMS の p95 (°/s) | 足先速度の大きい側の p95 (m/s) | 足先高さの最大変動幅 (mm) | hip の開始姿勢からの最大回転差 | 数値からの判断 |
| --- | ---: | ---: | ---: | ---: | --- |
| Idle | 3.60 | 0.0064 | 1.0 | 0.46° | 静かな基底として有望。全区間の loop 姿勢差 RMS は約 0°。 |
| Idle Looking Around | 48.39 | 0.4023 | 47.0 | 65.26° | 全身の大きな向き直りを含む。全区間を穏やかな idle と扱わない。 |
| Idle Looking Around 2 | 54.22 | 0.5739 | 76.9 | 75.88° | 上記と同じ。足先速度の最大値は右足 2.01 m/s。 |
| Idle Watching Something | 16.86 | 0.1861 | 46.1 | 23.74° | 静かな保持区間はあるが、全区間の足移動と入口姿勢差を解決する必要がある。 |
| VRMA_06_HandOnHip | 51.01 | 0.3796 | 41.9 | 30.43° | 体重移動を含む姿勢変更。root を消した全区間再生を安全な ambient と見なさない。 |

低エネルギー区間の例は Around `19.76–21.75 s`、Around 2 `9.27–11.25 s`、Watching `7.26–9.25 s` / `20.01–21.99 s`、HandOnHip `5.50–7.48 s`。それぞれの足先最大速度は約 1.55 / 1.59 / 0.91 / 2.11 / 6.58 cm/s。ただし静かな区間が、そのまま自然な接続区間とは限らない。

例えば Around の `19.76 s` の入口は、Idle 全体を 0.1 秒刻みで探索した最も近い姿勢からでも主要 bone の回転差 RMS 15.83°、足先位置差の大きい側は 21.80 cm。Around 2 の `9.27 s` は 37.80° / 28.09 cm、Watching の `7.26 s` は 25.78° / 23.71 cm。Watching の `20.01 s` は足差が 8.26 cm に小さくなるが回転差は 24.13°ある。これらは同じ hip 原点で姿勢差だけを最小化した参考値で、速度・支持脚を含めた最適解ではない。単純な低速フレーム抽出だけでは接続品質を保証できないことを示す。

HandOnHip は source の rest hip height が 0.87593 m あり、Yori への倍率は 1.04942。元の hip translation の変動幅は x 17.67 cm / y 1.82 cm / z 20.32 cm ある。この相対移動を保持すると右足先の平均速度は 8.46 → 1.47 cm/s、p95 は 22.78 → 5.21 cm/s へ下がる。支持側の移動を打ち消す役割が hip translation にあると解釈できる。左足はステップがあるため、速度が大きいこと自体を失敗とは断定しない。

一方、`vrma-converter` 由来の多くのファイルは平坦な bone node を持ち、source の `restHipsPosition.y` が 0。`Idle` には translation track もあるため、標準の `targetHipY / sourceHipY` を無条件適用すると無限大になる。解析ではこの場合の相対移動を「単位未校正」と記録し、メートル単位の FK に混ぜない。Around / Around 2 / Watching は translation track 自体を持たない。新しい実装で hip translation を復活させる際は、この構造差を必ず扱う。

これらの数値に基づく初期方針は、Idle を下半身も含む基底とし、他の収録素材を使う際は、接地を保つ遷移・必要な体重移動・活動に合う区間の指定を加えること。別の選択肢として収録済みの上半身を限定して重ねられるが、元の全身連動を損なわないかを別途目視する。静かな区間へのトリミングや低い weight だけで、安全性・自然さを実証したことにはしない。

解析の接地判定は「足先速度 4 cm/s 未満、clip 内の低い足先高さから 3 cm 以内」という proxy。床・靴底の実形状や ground truth は使っておらず、接地率を独立した足固定品質の点数にしない。Yori の mesh、ground correction、SpringBone、レイヤー合成を含む目視確認は別工程である。

| Item | Status |
| --- | --- |
| Public technical claims and primary-source research | Reviewed, 2026-09-13 |
| Recorded VRMA asset inventory / numeric analysis | See generated asset report alongside this document |
| Runtime implementation checks | Record separately with implementation results |
| Animates real-app observations | 20 window-only PNGs inspected; sparse idle observation only |
| Animates continuous recording | Captured with a window-only ScreenCaptureKit filter; see below |
| Controlled visual comparison | Pending |
| Blinded human comparison | Pending |
| Clear superiority to Animates | **Unverified** |

## Continuous installed-app reference capture

A later reference was captured on 2026-09-13 at 14:13:39 UTC using macOS ScreenCaptureKit. The capture selected the single window with application name/title `Animates` and bundle identifier `inc.animation.AniClaw`, then used `SCContentFilter(desktopIndependentWindow:)`. Child windows, cursor, microphone and audio capture were disabled. It did not record a display region.

The resulting local-only movie contains 579 frames at 578 × 1156 pixels over 20.183 seconds (about 28.7 frames/s), with no audio track. Maximum written-frame interval was 81.6 ms and writer backpressure dropped zero frames. These are capture diagnostics; they do not isolate Animates renderer performance. Dimensions, stream metadata and a montage were checked to confirm only the selected avatar window was present. The avatar remained in its standing idle presentation, with small body/eye changes and feet outside the view. This adds a continuous visual reference to the earlier sparse stills but supplies no same-avatar controlled comparison or human preference result.

The movie, acquisition metadata and Swift capture utility remain local review artifacts outside Git. A 30-second Yorishiro diagnostic video was also rendered at 24 frames/s using the same Yori model, light and camera for the procedural baseline and the new recorded-motion system. That video demonstrates the implemented behavior; comparing its motion variety with the short Animates idle sample cannot establish overall superiority.

## Longer installed-app observation, 2026-09-14

Two planned five-minute, window-only recordings were stopped by macOS. The first ended at roughly 150 seconds without a finalized movie, and its beginning overlapped a local browser-rendering task; it is not a valid benchmark. The second used the same exact Animates window filter with no concurrent intensive rendering. It was stopped by the system after 195.092 seconds (`SCStreamErrorDomain`, `-3821`), but the recorder finalized the acquired 4,432 frames into a valid silent 578 × 1156 movie. Metadata explicitly records `completedRequestedDuration=false`. Writer backpressure dropped zero frames; maximum presentation-time gap was 132 ms. Capture timing is not evidence of an Animates defect.

The second movie remains in the Git-ignored `.motion-review/animates-idle-5min-clean.mov`; despite the requested-duration filename, its observed duration is only 195 seconds. No input was sent by the recorder. A montage sampled every ten seconds shows larger changes in arm spread, hand orientation, torso lean and mouth opening around 130–190 seconds, following subtler early movement. The active conversation/music state could not be inspected, so the entire recording must not be labeled pure idle, nor can the cause of those movements be inferred. Ankles/feet remain outside the view and audio was not captured. This evidence broadens observed behavior but does not establish a controlled comparison, beat alignment, conversational appropriateness, contact quality or Yorishiro superiority.

## Current Yorishiro implementation check, 2026-09-14

After adding the upper-body physical candidate gate, preserving conversational
recordings at weight 0.85, fixing speech-to-listening/tool-activity boundaries,
and completing the explicit root-preservation path and optional local speech lab,
source `22720746` passed 3,047 tests in 241 files, TypeScript checking and a production
build. Biome passed all 47 changed TS/TSX/MJS/JS files since `2af32786`.
This establishes regression coverage, not motion
quality. The [implementation record](motion-orchestration.md) documents the
remaining build/test warnings and the scope of each check.

A fresh localhost-only browser with HMR and file watching disabled exercised
232 seconds of deterministic lab time and produced a separate 30-second film
under `.motion-review/orchestration-v3/`. The film contains 720 frames at 24 fps,
1400 × 1000 pixels, confirmed with `ffprobe`. It uses the current nine-clip catalog
and supersedes the older prototype-containing film for runtime review. No
Animates recording ran alongside this browser capture. This run predates the
optional speech UI and explicit root-preservation path; those additions leave
automatic catalog playback unchanged.

The recorded lane changed among Conversation, Chatting and Chatting 2 during
the 45-second explanatory interval. At the listening boundary its talking loop
stopped and attentive Idle began about 0.6 seconds later. Selected film frames
show visible conversational hand poses followed by lowered arms while listening.
The physical gate can decline a requested gesture; request-labelled screenshot
filenames do not imply admission. This film supplies conversation phases directly,
without spoken audio, so it does not validate word alignment or audible pauses.

The lab now separately offers user-clicked playback of a locally generated
24.052-second Japanese Kyoko sample. `node scripts/prepare-motion-speech-sample.mjs`
creates the WAV and text manifest without audible output or network synthesis.
Both lanes use the actual VoicePlayer playback clock and share mouth/expression
cues through the existing runtime bridge. Muted-browser QA sampled the real
analyser, observed recorded conversation, verified completion and interruption,
and reported no page errors. Approximately 100 ms frame spacing preserved Body's
real-time progress; a 300 ms delay stopped playback and cleared the mouth. The
observations and inspected 4/11-second stills are in
`.motion-review/speech-sample/qa/`. No microphone or autoplay is involved.
Estimated phrase offsets are not word alignment, and these checks do not approve
the timing or expressiveness of the resulting performance.

Sampled normalized foot markers remained within 1.496 mm of their first position
after the initial three seconds, versus 12.286 mm for the procedural baseline.
These values describe marker movement under this exact layered setup, not sole
penetration, universally stable contacts, or perceived naturalness. Source-faithful
conversion, target-avatar adaptation, continuous acting quality, and an Animates
comparison remain separate decisions; see [source replay review](source-motion-review.md).

An additional isolated player check compared direct official playback with
`rootMotion: "preserve"` on the same prepared source and contact-adapted clips.
Across seek and continuous replay, 60 paired hips/feet coordinate checks recorded
zero lane difference, with actual hips displacement of 41.626 / 37.751 mm.
The opt-in therefore retains translation for these inputs; it is not evidence
that automatic masked playback restores the original actor's full-body motion.
The default stays in-place and the candidates remain outside the automatic
catalog. The check excludes transitions, Body overlays and human preference;
details are in `.motion-review/runtime-root-preservation-qa.json`.

### Additional handoff review, 2026-09-14

Reviewing the existing film and real-audio observations revealed a finite-gesture
handoff gap: the old v3 film lowered the arms into its settling state before the
listening command, and speech observations contained several seconds with no
active recorded upper-body slot despite uninterrupted audio. A new actual-audio
run confirmed a 2.5-second scheduler delay after the finite performance. A narrow
Body completion change now reconsiders the conversational background while its
recovery fade continues, keeping physical rejection and other owners intact.
The repeat run had no sampled inactive interval at that handoff. This is removal
of unnecessary scheduling delay, not a requirement for constant movement.

An independent actual Web Audio probe also reproduced a same-task false
speaking → responding → speaking boundary on immediate audio replacement.
Announcing successful new playout before ending the old owner removed that
boundary; genuine stop, failed start and non-speech replacement retain their
release behavior. The combined affected suites passed 136 tests in six files,
plus TypeScript and Biome. See the [implementation follow-up](motion-orchestration.md#follow-up-conversational-handoff-fixes-2026-09-14)
for before/after timestamps, artifact paths, and limits. Earlier film and full
suite results predate these changes. Neither fix establishes superiority over
Animates; the input-method dependency and controlled comparison remain open.
