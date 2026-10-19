# データ保護台帳（2026-10-20、実装コードの調査結果）

本番データの取得・復元、実機移行の成功を示す台帳ではない。これらの実証が済むまで、本番切替・既存APKのアンインストール・ルール配備を禁止する。

| アプリ | 必ず保護するデータ | 保存場所（コード） | 移行方法 |
|---|---|---|---|
| Home | ニュースURL、更新間隔、トレーニング曜日、ウォッチリスト上書き、タイル並び順・非表示・追加リンク、起動回数、株価・ニュース・Web状態のキャッシュと取得時刻 | SharedPreferences `home_config`（`data/Config.kt`） | 暗号化ファイルへ全キーを型付き保存 |
| Home | 筋トレ・ドイツ語の日別完了、IELTS週別学習時間、優先順位算出の元データ | `priority_progress`（`focus/PriorityEngine.kt`） | 同上 |
| Home | Gmail旧日別通知件数・最終通知時刻・重複判定ハッシュ、新OAuth未読件数 `unread_count`・最終取得時刻 `unread_last` | `personal_gmail_update_counts`（`personal/PersonalInboxActivity.kt`） | 同上。個人画面限定 |
| Home | 個人用Backendトークン、端末Keystore暗号鍵、今後のGoogle OAuth認可 | `personal_home_secrets`、AndroidKeyStore、Googleアカウント | エクスポート除外・再認証。秘密情報を共有Homeへ送らない |
| Stock | アプリ・ウィジェットID別ウォッチリスト `symbols_*`、保有株 `holdings_json`（銘柄・株数・取得単価）、アラート `alerts_json`（種別・閾値・有効状態）、分析文章 `outlook_text` と日付 | `stock_widget_prefs`（`StockPrefs.kt`, `HoldingStore.kt`, `AlertStore.kt`） | 暗号化ファイルへ全キーを型付き保存。ウィジェットは再配置・新IDへの再設定が必要 |
| Stock | 分析APIキー `anthropic_api_key`（GeminiClientから参照） | 同上（旧キー）、新 `stock_secrets`＋AndroidKeyStore | エクスポート除外・再入力 |
| Stock | 更新確認時刻、クラッシュ診断履歴 | `stock_updater`、内部 `files/crash.log` | 暗号化バックアップ対象 |
| Stock | WorkManagerの定期アラート登録、OS通知・インストール権限 | WorkManager DB、Android OS | スケジューラで再登録。OS権限は再許可。内部ジョブDBの移植はしない |
| 婚姻手続 | チェック状態、追加タスク（日本語・独語、日付、削除印）、有効期限・実績日・予定日・計画、各項目の競合解決時刻・進捗算出元、旧形式 | localStorage `marriage_checklist_v2`, `marriage_checklist_v1`（`index.html`） | ローカル完全バックアップ。削除印・時刻も保持 |
| 婚姻手続 | 表示言語 | localStorage `marriage_checklist_cfg` | 同上 |
| 婚姻手続 | 夫婦共有チェックリストJSONと更新時刻 | RTDB `marriage-procedure/v1/marriage-procedure-2f9d4c7a8e`、Firebase project `warikan-app-120fd` | 管理者によるRTDB全体エクスポートと別環境復元の実証が先 |
| 家計簿 | 全月の支出（実績/予定、金額、日、カテゴリ、メモ、元定期支出ID）、削除済支出、収入 `salary`、予算、貯蓄目標、月ロック、継承元、定期支出（有効/削除印）、作成・更新時刻 | localStorage `baby-budget-data-v2`（`app.js`） | CSVでは情報不足。JSON完全バックアップが必要 |
| 家計簿 | 未送信操作（操作ID、種類、変更前後、順序）、直近カテゴリ、14世代/容量不足時2世代のバックアップ | `baby-budget-pending-v2`, `baby-budget-recent-categories`, `baby-budget-backups-v2` | 完全バックアップ・復元。キューを切り捨てない |
| 家計簿 | 月、支出、定期支出、全変更履歴、クラウドバックアップ、旧形式・スキーマ移行情報 | Firestore `spaces/household_budget_management_forbaby/{months,expenses,recurring,history,backups,budget}` | 管理者Firestore全体エクスポート、別プロジェクト復元、全ドキュメントのパス・件数・内容比較 |
| 両Webアプリ | Firebase認証セッション | Firebase Authが管理するIndexedDB等 | バックアップ対象外、承認済アカウントで再ログイン |
| 両Webアプリ | 承認UIDリスト・現在配備中ルール・他アプリデータ | RTDB `approvedMarriageUsers`、Firestore `approvedBudgetUsers`、同一プロジェクト全体 | 管理者バックアップ。現行ルールはリポジトリ断片のみでは判定できない |

新しい復元用の `restore-pending.json` / `restore-rollback.json` はAndroidの `noBackupFilesDir`、Webの `marriage:backup:{pending,rollback,hold}` / `baby-budget:backup:{pending,rollback,hold}` は同一originのlocalStorageに保存する。これらは復元操作用の退避・実行状態で、移行ファイルへ再帰的に含めない。復元前には現在の業務データを別の外部ファイルにも保存する。

一時APK・ダウンロードセッション・Webのバージョン再読込用sessionStorageはユーザーの永続データではなく再生成対象。

## 現時点の境界

- 既存PR: Home #7、Stock #1、婚姻 #1、家計簿 #2。最新のデフォルトブランチを確認し、Android両PRには既存の配布停止コミットを取り込んだ。
- Home #8 / Stock #2 のCI強化を保持する。
- `adb devices` に実機なし。Firebase管理者CLI/接続ツールなし。本番ルール・データは未取得、未変更。
- 旧APKにエクスポート機能がない場合、新署名APKは旧データを読み出せない。旧鍵は使わない。デバッグ可能な旧APKでは `scripts/legacy-adb-backup.mjs` により読み取り専用で内部データを暗号化書き出しできる（実機の可否は未確認）。デバッグ不可の場合は検証済みの別の抽出手段が確立するまで旧APKを残す。エクスポート画面を実装するだけでは既存端末の移行完了にならない。
