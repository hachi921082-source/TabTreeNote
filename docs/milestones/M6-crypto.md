# M6 — パスワード暗号化

> 派生ドキュメント。正本は [PLAN.md](../../PLAN.md) / [DESIGN.md](../../DESIGN.md)。横断ルールは [00-core-principles.md](../00-core-principles.md)、型は [data-model.md](../data-model.md)。

## ゴール（PLAN §7 M6）
`cipher`/`encFormat`/`sessionKeyStore`、暗号化変換（平文原本直接削除・順序厳守）、開封/保存（新 IV）/パスワード変更/ロック、暗号化メモの検索・AutoReName 除外・低頻度自動保存・厳格な履歴破棄（DESIGN §2.9）。

## 依存関係
- 先行: **M1（atomicWrite/eol）と M3（インデックス除外）に依存**（PLAN §7 依存関係）。

## このフェーズで扱う IPC チャネル（PLAN §2.4）
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `crypto:encryptMemo` | `{ tabId, memoName, password, hint? }` | `Result<MemoInfo>` | 平文 `.txt`→`.txtenc` 変換。平文原本は直接削除 |
| `crypto:decryptMemoToPlain` | `{ tabId, memoName, password }` | `Result<MemoInfo>` | 明示的な暗号化解除。`.txtenc`→`.txt`（平文は通常扱い） |
| `crypto:open` | `{ tabId, memoName, password }` | `Result<{ contentLF, eol, hash }>` | 開封（復号）。成功時セッション鍵をメイン保持（キー `(tabId, memoName)`）、本文平文をレンダラへ。`hash` は `.txtenc` **ファイル全体のバイト列**のハッシュ |
| `crypto:saveEncrypted` | `{ tabId, memoName, contentLF, eol, expectedHash? }` | `SaveResult` | 開封中メモの保存。`expectedHash` で外部変更競合検出 → セッション鍵で**新 IV** 再暗号化して書戻し |
| `crypto:changePassword` | `{ tabId, memoName, oldPassword, newPassword }` | `Result` | 新 salt+新 IV で再暗号化 |
| `crypto:lock` | `{ tabId, memoName }` | `Result` | セッション鍵破棄（再ロック）。レンダラは平文/履歴を破棄 |

## このフェーズで扱う型/データ構造
- **`.txtenc` フォーマット**（`magic`/`formatVersion`/`kdf`/`cipher`/`eol`/`hint`/`ciphertextB64`）→ [data-model.md](../data-model.md) §3 に転記済み。
- **scrypt 既定**: N=32768（2^15）/r=8/p=1/keyLen=32。ファイルに記録し復号時はファイル値を使う。**非同期 `crypto.scrypt` を `await`**（同期版禁止）、`maxmem` を明示的に十分な値（例 64MB）へ。→ [data-model.md](../data-model.md) §3。
- **セッション鍵ストア**: 開封済みメモの導出鍵をメインのメモリ上にのみ保持。**キーは `(tabId, memoName)` の組（またはメモの絶対パス）。`memoName` 単体をキーにしない**（異なるタブに同名暗号化メモが共存しうるため鍵衝突する実バグになる, PLAN §1.4/§5.5）。
- `MemoInfo`（`encryptMemo`/`decryptMemoToPlain` の返却, `encrypted` フラグ）。

## このフェーズで扱う処理フロー

### 暗号化変換フロー（平文→`.txtenc`, PLAN §5.4 / `crypto:encryptMemo`）
1. パスワード確認入力（レンダラのダイアログ）→ password をメインへ。
2. メイン: 平文 `.txt` を読み込み（メモリ）。新規 salt + scrypt で鍵導出（**非同期 `crypto.scrypt` を `await`**）、新規 IV で AES-256-GCM 暗号化、`.txtenc` コンテナを構築。
3. `selfWriteRegistry` に `.txtenc`（add）と 平文 `.txt`（unlink）を登録。
4. `atomicWrite` で `.txtenc` を書込（temp→fsync→rename）。**書き込み永続化を fsync で確認**。
5. **確認後に**元の平文 `.txt` を**ごみ箱を経由せず直接 `fs.unlink`**（DESIGN §2.9 平文原本削除。順序厳守=`.txtenc` 永続化後に削除）。
6. インデックス経路①: 該当メモを「本文除外・メモ名のみ」に更新。
7. セッション鍵ストアに導出鍵を保持（そのまま開封状態にしてよい）。
- **途中クラッシュ時**: `.txtenc` rename 前なら平文が残り再開可能。`.txtenc` 生成後・unlink 前なら平文と暗号版が一時併存 → 起動時突合で同名衝突を検出したら暗号版を優先し平文を要確認として扱う（PLAN §8-3）。

### 開封 / 保存 / パスワード変更 / ロック（PLAN §5.5 全文相当）
- **開封 `crypto:open`**: `.txtenc` を読み、ファイル内 KDF パラメータ+salt で鍵導出（非同期 `crypto.scrypt` を `await`）、IV+tag で復号。認証タグ検証失敗→`DECRYPT_FAILED`（「パスワードが違います」、本文は返さない）。成功→セッション鍵ストアへキー `(tabId, memoName)` で鍵保持、平文本文+eol に加え `.txtenc` 現状の `hash`（次回保存の競合判定用。ディスク上の `.txtenc` **ファイル全体のバイト列**のハッシュ）をレンダラへ返す。
- **保存 `crypto:saveEncrypted`**: **競合チェック** — 現在のディスク上 `.txtenc` のハッシュを計算し `expectedHash`（開封時/前回保存時の hash）と比較。不一致なら `evt:conflict` 発火し保存中断（平文 `memo:save` と対称。watch は `.txtenc` も監視対象）。一致時のみ → セッション鍵で**新 IV** 生成し再暗号化 → `atomicWrite`（`.bak` も暗号化済み）→ 新ハッシュを `SaveResult{ savedHash }` で返却。salt は流用。自動保存は低頻度デバウンス（既定 5s）。
- **パスワード変更 `crypto:changePassword`**: ①旧 PW で復号確認 → ②新 PW → ③**新 salt+新 IV** で再暗号化 → ④temp 書込+fsync → ⑤アトミック rename。失敗時は rename しないだけでロールバック不要。
- **ロック `crypto:lock`（未保存データの扱いを含む）**:
  1. **ロック実行前に dirty（未保存）があるかをチェック**。dirty なら**メモ切り替え時と同様にロック前に自動保存（`crypto:saveEncrypted`）してからロック**（DESIGN §2.6 の「メモ切り替え時」自動保存トリガーに準じる。無確認でのデータ破棄はしない）。既定は自動保存を優先。「保存せず破棄」を選べる UI を用意するかは developer 判断だが、**既定挙動は自動保存**。
  2. 保存完了後（または dirty でない場合は即）、当該メモのセッション鍵をストアから破棄（キー `(tabId, memoName)`）。
  3. レンダラは CodeMirror ドキュメント + Undo 履歴を破棄（DESIGN §2.9 厳格破棄）。
  - メモ切替/終了時も同様（切替/終了前に dirty なら自動保存 → 鍵破棄 → 履歴破棄）。

### 復号平文のレンダラ供給（PLAN §1.4）
- 鍵とパスワードはメインに閉じる。**復号本文テキスト自体はレンダラ（CodeMirror）へ渡す**（DESIGN の禁止事項=鍵/パスワードのレンダラ露出・平文のディスク永続化・平文のインデックス取り込み、には該当しない）。
- 平文残留防止: メモ切替/ロック/終了時にレンダラ側の CodeMirror ドキュメントと Undo 履歴を破棄。メイン側もセッション鍵の失効/破棄を行う。

### 暗号化メモの各種制約
- **検索**: 本文は常にインデックス対象外・メモ名のみ（M3 / DESIGN §2.4）。
- **AutoReName 除外**: 暗号化メモ（`.txtenc`）は AutoReName 対象外・手動リネームのみ（DESIGN §2.2、AutoReName 本体は M7）。
- **低頻度自動保存**: 暗号化メモの自動保存は「編集停止から一定時間（例 5 秒以上）のデバウンス」または「手動保存・メモ切り替え時のみ」（DESIGN §2.6）。
- **厳格な履歴破棄**: 閉じる/切り替え/(再)ロック/終了のいずれでも Undo/Redo 履歴（平文を含みうる）をメモリから確実に破棄（DESIGN §2.9）。

## このフェーズで扱うディレクトリ/ファイル（PLAN §3）
- `src/main/crypto/cipher.ts` — scrypt(非同期) + AES-256-GCM、`.txtenc` シリアライズ/パース
- `src/main/crypto/encFormat.ts` — `.txtenc` フォーマット定義とバージョニング
- `src/main/crypto/sessionKeyStore.ts` — 開封中メモの導出鍵をメモリ保持（永続化しない）。キーは `(tabId, memoName)`（memoName 単体をキーにしない）
- `src/main/ipc/cryptoHandlers.ts`
- レンダラ `src/renderer/components/dialogs/` — パスワード入力ダイアログ（設定/解除/開封/変更、確認再入力・ヒント表示・警告）

## このフェーズのエラーハンドリング（[00-core-principles.md](../00-core-principles.md) §8）
関連行: 「暗号復号失敗（誤 PW/改ざん）」= `DECRYPT_FAILED`、本文は一切返さない。「保存中クラッシュ」（暗号変換は `.txtenc` 永続化後に平文削除で平文喪失を防止）。「外部編集競合」（`crypto:saveEncrypted` の `expectedHash`）。
- **セキュリティ不変条件（[00-core-principles.md](../00-core-principles.md) §10）を厳守**: 鍵/パスワードをレンダラへ渡さない、復号平文をディスク/インデックス/内部ログに出さない、`.bak` も暗号化済みデータ。

## DESIGN.md の関連セクション
- 暗号化の設計判断（方式 AES-256-GCM / scrypt、IV 再利用禁止、salt の扱い、`.txtenc` 形式、鍵管理、UX、平文原本削除、履歴破棄、忘失時復旧不能）: DESIGN §2.9。
- 暗号化メモと検索の関係: DESIGN §2.4。AutoReName 除外: DESIGN §2.2。低頻度自動保存: DESIGN §2.6。

## PLAN §8 整合メモの関連項目
- **メモ 1**（暗号化状態の真実源=拡張子 `.txtenc`、メタに暗号フラグを持たない）。
- **メモ 2**（復号平文のレンダラ供給は DESIGN 禁止事項に該当しないと解釈。鍵はメインのセッション鍵ストアに閉じる）。
- **メモ 3**（暗号化変換中クラッシュで平文・暗号版が併存した場合、起動時突合で暗号版優先・平文は要確認、自動削除しない）。
- **メモ 4**（scrypt コストパラメータ具体値 N=32768/r=8/p=1/keyLen=32 を初期既定とし、ファイル記録で将来引き上げ可能）。
- **メモ 7**（暗号化変換中の外部変更競合は非検出＝受容済みリスク）。
