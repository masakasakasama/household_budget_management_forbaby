# handoff.md — おうちの家計簿

次の人（や次の自分）が続きから進められるようにまとめたメモ。

## いま何ができているか（v1.1.0）

かわいいパステルの **Webアプリ版** 家計簿。フレームワーク・ビルド不要、`index.html` を開くだけで動く。

- 月ごと管理（前月/翌月・月ピッカー）
- 収入 / 固定費 / 生活費（項目追加・削除・▲▼で並べ替え）
- クレジットカード利用控え・特別支出（テーブル、行追加・削除・並べ替え）
- 残高（来月へのくりこし）自動計算 / 貯金ぶたメーター / メモ
- **複数デバイス同期**（jsonblob.com・認証/APIキー不要・無料）
  - 「🔗 端末を同期」→ 共有ブロブ作成 → リンク/おうちコード発行
  - 別端末で同じリンク（`?ouchi=<id>`）を開く、または「🏠 参加」でコード入力
  - 起動時pull / 15秒ごとpull / タブ復帰時pull / 編集時はdebounce push
  - last-write-wins（state全体を `updatedAt` で比較）
- **オフライン耐性**：localStorageキャッシュを常に表示。通信失敗時は最後に成功したデータを表示し、ステータスに「⚠️ オフライン」表示
- 「前回同期 HH:mm」表示（同日でなければ日付も表示）
- アプリ更新チェック：`version.json` を取得し `APP_VERSION` と差異があれば「再読み込み」案内

## ファイル

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面構造（ヘッダー / 同期バー / 各カード / 共有モーダル） |
| `style.css` | パステルなかわいい見た目 |
| `app.js` | 入力・自動計算・同期ロジック（`APP_VERSION` 定数あり） |
| `version.json` | 公開中バージョン（更新チェック用） |
| `.github/workflows/pages.yml` | GitHub Pages へ自動デプロイ |

## 公開リンク（GitHub Pages）

- 想定URL: `https://masakasakasama.github.io/household_budget_management_forbaby/`
- **初回のみ手動設定が必要**：GitHub → リポジトリ → Settings → Pages →
  「Build and deployment」の Source を **GitHub Actions** に設定。
  以後 `main` / `claude/cute-budget-app-zVv6p` への push で自動デプロイ。

## バージョン更新の手順

1. `app.js` の `APP_VERSION` を上げる
2. `version.json` の `version` を同じ値にする
3. push → Pages 自動デプロイ → 既存利用者に「再読み込み」案内が出る

## Notion「Working Style for AI」要件への対応状況

| 要件 | 状態 | 補足 |
| --- | --- | --- |
| GitHubリポジトリに格納 | ✅ | |
| スマホから開ける共有リンク | ✅(要初期設定) | Pages の Source 設定が初回必要 |
| 複数デバイスで同じリンク→常時同期 | ✅ | jsonblob、last-write-wins |
| ローカルキャッシュ / 通信失敗時に最後の成功データ | ✅ | localStorage |
| 起動時更新・手動更新・バックグラウンド更新 | ✅ | pull(起動/15s/復帰)、更新ボタン |
| 前回更新 HH:mm 表示 | ✅ | |
| リストの並べ替え | ✅ | ▲▼ボタン |
| 設定・選択内容の保存 | ✅ | localStorage + 同期 |
| 日本語UI / 直感的 / 数字だけで判断させない | ✅ | ラベル・ぶたコメント |
| 無料・APIキー無し | ✅ | jsonblob無料枠 |
| README に制限事項 | ✅ | README参照 |
| **Android APK + ホーム画面ウィジェット** | ❌ 未対応 | 次フェーズ（下記） |
| **黒背景ベース・iOS風** | ⚠️ 不採用 | ユーザー指示で「かわいい」優先 |

## 既知の制限・注意

- **同期の競合**：同一stateを丸ごと last-write-wins。2端末が同時刻に別項目を編集すると、後勝ちで一方の変更が消える可能性。MVP想定。将来は項目単位マージで改善余地。
- **jsonblobの保持**：75日アクセスが無いとブロブ削除。通常利用なら問題なし。バックアップは各端末のlocalStorageに残る。
- **jsonblobのLocationヘッダ**：作成時にブロブIDを `Location` レスポンスヘッダから取得。万一CORSで読めない環境では作成に失敗するため、その場合は別途キー入力式バックエンド（kvdb.io等）への差し替えを検討。
- **GitHub Pages の初期設定**：上記の通り Source を GitHub Actions にする初回操作が必要。

## 次にやること（候補・優先順）

1. GitHub Pages の Source を GitHub Actions に設定し、実リンクで動作確認
2. 同期の競合をやさしくする（項目単位マージ / 簡易バージョンベクタ）
3. 円グラフなどの可視化（支出内訳）
4. （要件のフル対応）Android APK + ホーム画面ウィジェット（WebView+Capacitor等、無料・ストア非公開）
