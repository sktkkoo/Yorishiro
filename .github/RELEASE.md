# Release

内部リリース手順。このファイルはリポジトリには公開しない（`.github/` 内に配置）。

## トリガー

- `git tag v0.4.0 && git push origin v0.4.0` — tag push で自動実行
- GitHub Actions 画面から **Run workflow** で手動実行

## ビルド対象

| arch | runner |
|---|---|
| aarch64 (Apple Silicon) | `macos-latest` |
| x86_64 (Intel) | `macos-13` |

## Private assets

再配布不可のアセット（モーションデータ・3D モデル）は Cloudflare R2 に `assets.zip` として格納し、ビルド時に S3 互換 API でダウンロードする。

zip の中身：
```
assets.zip
├── animations/*.vrma
└── models/*.vrm
```

アセットを更新する場合は `public/` 内の `animations/` と `models/` を zip にして R2 バケットに再アップロードする：
```bash
cd public
zip -r ../assets.zip animations/ models/
# R2 に assets.zip をアップロード
```

## GitHub Secrets

| Secret | 用途 |
|---|---|
| `R2_ACCESS_KEY_ID` | Cloudflare R2 アクセスキー ID |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 シークレットアクセスキー |
| `R2_ENDPOINT` | R2 S3 互換エンドポイント (`https://<account-id>.r2.cloudflarestorage.com`) |
| `R2_BUCKET` | R2 バケット名 |
| `APPLE_CERTIFICATE` | Developer ID Application 証明書 (.p12) の base64 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 のパスワード |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID メールアドレス |
| `APPLE_PASSWORD` | Apple ID の App 用パスワード |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

## 成果物

- tag push 時：GitHub Release（draft）に `.dmg` が添付される
- 手動実行時：Actions の Artifacts に `.dmg` がアップロードされる
