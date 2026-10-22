# 4アプリのセキュリティ・データ保護改修（2026-10-20）

**未完了・本番移行不可。** コード改修、合成データによる復元、異なる署名への移行検証は実施した。既存実機の保存データと本番Firebaseを保全・復元した証拠はまだない。本番ルール配備、マージ、APK公開、旧実機APKのアンインストールは実施していない。

## 保存データとバックアップ・復元

完全なコード調査台帳は [DATA_PROTECTION_INVENTORY.md](DATA_PROTECTION_INVENTORY.md)。全リポジトリの `docs/DATA_PROTECTION_INVENTORY.md` にも同じ台帳を保存する。

| アプリ | 保護するデータと保存場所 | バックアップ方法 | 復元方法 |
|---|---|---|---|
| Home | `home_config`: 設定、タイル・順序・非表示・追加リンク・起動回数、各オフラインキャッシュ。`priority_progress`: 日別完了・週別学習時間。`personal_gmail_update_counts`: 旧通知集計・新OAuth未読件数 | 設定→バックアップ・復元→エクスポート。Android SAFで保存先選択。AES-256-GCM、PBKDF2-SHA256 210,000回。秘密情報は除外。旧デバッグAPK用ADB補助ツールも用意 | 同画面でファイル・パスフレーズ選択→形式・型・内容確認→既存内容置換の確認。全キー・型・内容を読込照合。端末内退避と失敗時・再起動時ロールバック。個人Backend/Gmailは再認証 |
| Stock | `stock_widget_prefs`: 全ウォッチリスト、ウィジェットID別設定、保有株、アラート、分析文章・日付。`stock_updater`: 更新確認。`files/crash.log`: 診断履歴 | メイン画面→バックアップ・復元。Homeと同じ暗号化・SAF・読込照合。分析APIキーは除外。旧キーはKeystore暗号化保存へ読込照合後に移動 | Homeと同じ型付き復元・確認・ロールバック。新ウィジェットIDはOSが再発行するため再配置・銘柄再設定が必要。分析APIキーは再入力 |
| 婚姻手続 | localStorage `marriage_checklist_v2`, `marriage_checklist_v1`, `marriage_checklist_cfg`: チェック、追加タスク、計画・期限・実績日、削除印・競合解決時刻、言語。RTDB `marriage-procedure/v1/marriage-procedure-2f9d4c7a8e` | ページ末尾の暗号化完全バックアップ。対応ブラウザは保存先選択・再読込検証、非対応はダウンロード後に再読込して確認。クラウド全体は管理者バックアップが別途必要 | 暗号化ファイル検証→件数表示→置換確認→全キーの内容照合。失敗時と再読込時のロールバック。クラウド同期は内容確認ボタンまで保留し、再開後は項目ごとの時刻付きマージ |
| 家計簿 | `baby-budget-data-v2`: 全月の支出・予定/実績・削除印、収入、予算、貯蓄目標、月ロック、定期支出。`baby-budget-pending-v2`, `baby-budget-backups-v2`, `baby-budget-recent-categories`: 未送信操作、世代バックアップ、最近のカテゴリ。Firestore `spaces/household_budget_management_forbaby` 以下の月・支出・定期・履歴・バックアップ・旧スキーマ | ページ末尾の暗号化完全バックアップ。CSVだけでは移行不可。クラウド履歴や旧データを含む全体は管理者バックアップを別途取得 | 婚姻手続と同じ照合・確認・ロールバック。同期再開を確認すると同じエンティティIDで復元内容をキューへ登録。従来の世代復元も、新しい支出等を残し、同期保留と退避を使う |

アプリ秘密情報、Firebase Authのブラウザセッション、AndroidKeyStoreの鍵は移植しない。復元操作自身のジャーナルは端末内に保存し、再帰的な移行ファイルには含めない。**復元前の外部バックアップも別ファイルで保持する。**

## 修正内容・機能維持・検証状況

| 対象 | セキュリティ修正・既存機能の扱い | 実施済み検証 | 未検証・本番反映 |
|---|---|---|---|
| Home PR #7 | 新秘密鍵・Secrets、APK SHA-256に加えてインストール済みアプリとの署名・パッケージ・版数照合。GmailはOS通知アクセスを使わず、個人画面のOAuth読み取り専用 `gmail.metadata` で未読件数だけ取得。個人Gmailを共有Backendへ送らない。タイル・優先順位・設定・キャッシュ・自動更新処理は維持 | Debug/署名付きReleaseビルド成功、単体8件、ADB変換テスト2件。Android API34で異署名上書き拒否→暗号化バックアップ→QAアプリ再インストール→復元内容照合→ロールバック。ADB旧形式からの実際のAndroid復元も成功 | 実機データ、SAF保存先選択の実機操作、Google OAuth認可、更新配布経路の実機検証は未実施。本番未反映 |
| Stock PR #1 | Homeと同じ新署名。署名権限を保持。APIキーのKeystore保管、APIキー・秘密領域の移行除外、APK検証を追加。ウォッチリスト・保有株・アラート・分析・更新処理を維持 | Debug/署名付きReleaseビルド成功、単体5件、ADB変換テスト2件。API34で異署名移行・復元・ロールバック、APIキー暗号化移行、Homeからのウォッチリスト読取成功、権限のないshellからの読取拒否 | 既存ウィジェットを含む実機回帰、分析API/市場データ通信、実機配布更新は未実施。本番未反映 |
| 婚姻 PR #1 | 承認されたGoogle UIDのみ許可するルール断片。固定データパスを保持。サーバートランザクションでオフライン変更を項目単位マージ。チェック・追加タスク・日付・言語を維持 | Node単体10件、ブラウザ暗号化書出→別ブラウザ復元→誤パスワード拒否→内容照合→ロールバック成功。RTDBエミュレータで承認2人、第三者/未認証/匿名拒否、2クライアントのオフライン復帰、他アプリ用ルールの共存を検証。従来のブラウザ同期回帰（同時編集、権限失敗、再起動、保存容量不足、再送）も成功 | エミュレータの認証属性はテスト用。本番Google認証の2実機同期、現在配備中ルールの確認、管理者バックアップと復元は未実施。本番未反映 |
| 家計簿 PR #2 | 匿名認証・自己承認を廃止、Google認証と管理者作成の `approved:true` のみ許可。未送信キューの500件切捨て・送信中の追加操作消失を修正。永続キュー→直列送信→操作IDによる冪等化。トランザクションで履歴・変更前後を保持し、異なる項目・予算行をマージ。支出・収入・予算・定期・履歴等を維持 | Node単体10件。601操作保持、送信中追加、認証失敗再送、同操作再送、別予算行の同時変更を検証。ブラウザ完全復元・ロールバック成功。Firestoreエミュレータで承認2人、第三者/未認証/匿名/無効化アカウント拒否、2クライアントのオフライン書込と履歴保持、他アプリ用ルール共存を検証 | 本番2実機同期、現在配備中ルール、クラウド管理者バックアップ/復元、既存クラウドとの全件照合は未実施。本番未反映 |

全機能の実機回帰に合格したという意味ではない。合成データのエミュレータ試験と、ユーザーの実データ・実機試験は明確に区別する。

## 鍵・配布・検査の証拠

- 新しい共有署名鍵を生成済み。Home/Stockの計8個の `*_SIGNING_*` Secretsへ登録済み。秘密値はログやGitへ出していない。
- 公開してよい新証明書SHA-256: `0c949211f46894cd1e2b3754dde94292dad48de890cecb24920feea65d3f46de`。
- 新証明書SHA-1: `71:3B:19:01:82:B7:A2:8A:C9:2E:5D:B9:84:08:E8:E0:9A:5A:76:E7`。
- ローカル署名済みAPKのSHA-256: Home `5727af01df91e3ad88cdd2f2ff7af1134bfec9e98df2c7ea8ff0fc11768cf987`、Stock `7d2d7f58dff48aee2dc5e318d099e4d5ca42b05e984208b2c53b0ef7574f060b`。両方 `apksigner verify --verbose --print-certs` 成功。同じ新証明書を確認。公開していない。
- Git履歴の漏洩鍵は既知の侵害済み情報であり、削除しても失効しない。旧鍵で新たな署名は行っていない。合成データ試験用に作った別の旧/新テスト鍵は、本番鍵と別物。
- Gitleaks 8.30.1で4履歴を検査。Home/Stockのテキスト秘密値は検出0、両Webの検出は既存Firebase Web APIキー。これらは認可の代用ではないため、RulesとAPIキー制限の確認が必要。バイナリの漏洩署名鍵が「安全」と判断されたわけではない。
- 両WebのFirebase/Playwright等を更新し、Node用gRPCの修正版を明示。開発依存を含む `npm audit` は両方0件。Firebase CLIの多数の依存を試験に持ち込まず、公式Javaエミュレータを既知のSHA-256で検証して起動する。
- Home #8 / Stock #2 のCI強化を保持。全アプリにテスト経路、CodeQL、Dependabotを配置。CodeQLの実行結果はGitHub側のチェック結果を確認する。新APK公開は `DATA_MIGRATION_VERIFIED=true`、家計簿Pages配備は `FIREBASE_MIGRATION_VERIFIED=true` を実証後に設定するまで進まない。婚姻手続は既存のlegacy Pagesがmainブランチ直結なので、マージ自体が本番配備になる。実証までドラフトPRをマージしない。

## ユーザーが実施すべき操作（順序を変えない）

| 順序 | 必要な操作 | 完了証拠・停止条件 |
|---|---|---|
| 1 | 旧Home/Stockを残したままAndroid実機をUSB接続し、USBデバッグを認可する。編集を保存しアプリ/ウィジェットを終了する。デバッグ可能なら各repoで `node scripts/legacy-adb-backup.mjs Home DEVICE_SERIAL OUTSIDE_REPO/Home.hbk` / Stock を実行。パスフレーズは環境変数 `BACKUP_PASSPHRASE` に対話入力し、チャットやコマンド引数に書かない | 読み取り専用。ファイル再読込・復号・全項目照合の成功。`run-as` が拒否されたら中止。旧鍵を使う・アンインストールする回避策は採らない |
| 2 | 別のテスト端末へ新署名APKとバックアップをコピーし、アプリのインポート画面で復元する。設定・優先順位・保有株・アラート・連携、再起動、オフライン操作、ロールバック、ウィジェット再配置を確認 | 元端末のデータを残した状態で、件数と内容が一致すること。これが成功するまで元端末をアンインストールしない |
| 3 | Firebase管理者で現行RTDB/Firestore Rulesと全データを保存する。両端末の編集を止めた整合した時点を選び、Google公式のFirestore全体エクスポートを取得。RTDBも全体を取得する。補助の `scripts/firebase-admin-backup.mjs capture PROJECT RTDB_ROOT_URL OUTSIDE_REPO/backup.backup` は短期管理者トークン `GCP_ACCESS_TOKEN` と `BACKUP_PASSPHRASE` で全ドキュメント型・パス、RTDB全体、配備中Rulesを暗号化して再読込検証する | 本番からの実取得は未実施。補助スクリプトは読取専用で、標準のクラウド管理バックアップも併用。Firebase Authユーザー/プロバイダ情報の管理者バックアップも別途保管 |
| 4 | 管理バックアップを別Firebaseプロジェクトに復元し、同じcaptureを実施。`node scripts/firebase-admin-backup.mjs compare BEFORE RESTORED` でFirestore全パス・件数・型付き内容とRTDB全内容の一致を確認する | 管理者復元・全件照合が成功するまで本番ルールを変更しない。補助スクリプトの合成データ試験は本番復元の証拠ではない |
| 5 | Googleログインを有効化し、夫婦2人のUIDだけを管理者登録する。RTDBは `approvedMarriageUsers/<UID>:true`、Firestoreは `approvedBudgetUsers/<UID>` に `approved:true`。現行共有プロジェクトの親・再帰ワイルドカードを調査し、対象の公開許可だけを狭め、他アプリの実効ルールを維持してステージングで検証する | 広い親許可は子ルールの拒否では打ち消せない。他アプリを含め承認/未承認テスト。未承認の承認リスト編集も拒否されること |
| 6 | 実Googleアカウントの2実機で同期・同時編集・オフライン編集・再接続・再認証を確認する。新署名のAndroid OAuthクライアント登録とGmail API/同意画面を設定し、個人用Gmail認可・取消を確認する。公開 `Home-Downloads` 配布とHome/Stock更新経路を検証する | 個人情報が共有Homeへ出ないこと、元データとの一致、第三者拒否。既存機能を停止した状態で移行完了にしない |
| 7 | Windows鍵保管場所 `LOCALAPPDATA/CodexSecurityKeys/Home-Stock-20261020` のPKCS12とDPAPI保護されたパスワードを、管理されたオフライン保管へ二重化する。DPAPIファイルだけでは別ユーザー/別PCで復号できない | パスワードマネージャー等への安全な回復手段を確立。秘密値をGit、メール、チャットへ貼らない |
| 8 | 上記の実証を記録した後にだけ、本番Rules・公開・マージを実施する | 現在は未許可の前提ではなく、ユーザー指定のデータ保護条件が未充足のため未実施 |

参考: [Androidの署名と更新](https://developer.android.com/studio/publish/app-signing)、[GoogleのAndroid認可](https://developer.android.com/identity/authorization)、[Gmailラベル取得と必要権限](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/get)、[Firestore管理エクスポート/インポート](https://firebase.google.com/docs/firestore/manage-data/export-import)、[Firebase Rulesの実効権限](https://firebase.google.com/docs/rules/rules-behavior)。


## 2026-10-22追加改修

公開ファイルだけのオフラインキャッシュを実装し、通信遮断中の再読込・編集・再読込をブラウザで確認。破損JSONや不正な保存形式は初期データで上書きせず、原本を残してバックアップ復旧画面を表示する。各12件の単体、暗号化復元・ロールバックと破損回復のブラウザ試験、Firebaseルール試験が成功。婚姻の同期回帰も成功。実機・管理者バックアップ・本番反映は未実施。詳細は [移行上の負担・制限](MIGRATION_TRADEOFFS.md)。
