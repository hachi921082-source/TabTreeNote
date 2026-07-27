# M8 — ノードロック基盤

> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは機能1「ノード（サブツリー）単位のパスワードロック」の**基盤部分**（単発のロック/解除/再ロック）を扱う。
> ロック解除セッション中の構造変更・境界を跨ぐ移動/コピー・タブ切替時の一括破棄は [M9-node-lock-session-ops.md](M9-node-lock-session-ops.md) で扱う。

## ゴール（PLANv3 §1/§2.1/§4/§5.1/§5.2）
単一ノードを起点にサブツリーをロック/ロック解除/再ロックする基本機構を実装する。難読化ファイル名の採番、ブロブの暗号化/復号、`claimedTokens`による孤児ファイル露出対策、セッションストアへの保持、ツリー上の「🔒(ロック中)」表示までが一通り動く状態がゴール。ロック解除セッション中に配下メモを作成・リネーム・削除する等の**構造変更操作自体はM9のスコープ**（本マイルストーンでは、解除直後に返る`TreeNode[]`が正しく表示されるところまでで良い）。

## 依存関係
- 先行: v1 **M1**（`atomicWrite`/`.bak`/`eol`、ファイル層コア）、**M2**（ツリーUI・右クリックメニュー・DND基盤）、**M6**（`cipher.ts`の鍵導出・AES-256-GCMプリミティブ、`sessionKeyStore`と対称のセッション管理パターン）に依存。
- 後続: [M9](M9-node-lock-session-ops.md) は本マイルストーン完了が前提。

## このフェーズで扱う IPC チャネル（PLANv3 §2.1）
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `crypto:lockNode` | `{ tabId, memoName, password, hint? }` | `Result<void>` | 対象ノード(現在の可視ツリー上の`memoName`)を起点にサブツリーをロックする。個別暗号化(`.txtenc`)が対象配下に混在する場合は`LOCK_CONTAINS_ENCRYPTED`（DESIGNv3 §1.10）。処理内容は下記フロー参照 |
| `crypto:unlockNode` | `{ tabId, memoName, password }` | `Result<{ lockToken: string; tree: TreeNode[] }>` | ロック中ノード(`memoName`は難読化トークン)をパスワードで復号しセッション開始。誤りは既存`DECRYPT_FAILED`を再利用 |
| `crypto:relockNode` | `{ tabId, lockToken }` | `Result<void>` | 単一セッションの明示的破棄（メモリ上の対応表・復号済み構造を破棄するのみ。ファイル操作なし, DESIGNv3 §1.5） |

> `crypto:lockNode`/`crypto:unlockNode`の`lockContext`引数（入れ子ロック用）、`crypto:relockAllInTab`（一括破棄）はM9で扱う。本マイルストーンでは`lockContext`省略時（タブ直下の可視ツリーが対象）のみを実装すればよい。

## このフェーズで扱う型/データ構造（PLANv3 §4）
```ts
interface NodeLock {
  kdf: { algo: 'scrypt'; N: number; r: number; p: number; keyLen: number };
  saltB64: string;
  ivB64: string;
  tagB64: string;
  hint?: string;
  blobCiphertextB64: string;   // 復号後: NodeLockBlob（JSON）
  claimedTokens: string[];     // 【最重要】占有中の難読化ファイル名(起点ノード自身を含む)の平文一覧。詳細は下記参照
}

interface NodeLockBlob {
  realMemoName: string;            // ロック起点ノード自身の元の表示名。children には含まれない
  children: MetaTreeNode[];        // 配下の「子」ノードのみ。内部は平文表現でよい（ブロブ自体が暗号化されているため）
  nameMap: Record<string, string>; // realName -> obfuscatedFileName（起点ノード自身の分も含む）
}

interface MetaTreeNode {
  // ...既存フィールド（v1 data-model.md 参照）
  lock?: NodeLock;   // 存在する場合「ロック中」。children は常に []
}

interface TreeNode {
  // ...既存フィールド（v1 data-model.md 参照）
  // 既存の編集ロック用 locked?: boolean と衝突するため、ノードロックのマーカーは別名 nodeLocked を使う
  // （DESIGNv3.md §1 冒頭の追記「フィールド名の確定」参照。PLANv3.md §4 のこの箇所の表記を訂正）。
  readonly nodeLocked?: true;    // true: ロック中(セッション無し)の起点ノード。UIは常に「🔒(ロック中)」表示、children は空
  readonly lockToken?: string;   // ロック解除セッション配下（起点＋子孫全て）に付与
}

type NodeLockErrorCode =
  | 'LOCK_CONTAINS_ENCRYPTED'  // ロック対象に既存M6個別暗号化メモが混在
  | 'LOCK_SESSION_NOT_FOUND';  // 指定セッションが存在しない
```

**`claimedTokens`が必須である理由（最重要・PLANv3 §7.1）**: `tabService`は起動時・タブオープン時に「フォルダ直下の実ファイル」と「メタJSON上のノード」を突合し、対応の無い実ファイルをツリー末尾へフラット追加する（v1の既存フォールバック）。ロック中ノードの子孫の難読化ファイルはメタ上`children:[]`のため対応が無く、このフォールバックに従うと**ロックで隠したはずの子孫ファイルが素性不明の孤児ノードとしてツリーに露出してしまう**。`lock.claimedTokens`（占有中の難読化ファイル名の平文リスト。ランダムHEX文字列の列挙のみで名前・階層情報は含まない）を突合ロジックの孤児判定から除外する条件として使うことで解消する。**本マイルストーンで`tabService`の突合ロジックを拡張する際、この対応漏れが起きないよう最優先で確認すること。**

## このフェーズで扱う処理フロー（PLANv3 §5.1/§5.2）

### ロック実行フロー（`crypto:lockNode`）
1. 対象ノード配下（起点+子孫）を実行時ツリーから収集。いずれかが既存`.txtenc`(個別暗号化)なら`LOCK_CONTAINS_ENCRYPTED`で中断（DESIGNv3 §1.10）。
2. パスワードから新規salt+非同期`crypto.scrypt`で鍵導出（既存`cipher.ts`の導出関数を再利用）。
3. 起点+子孫それぞれについて`obfuscatedNaming.generate()`（`crypto.randomBytes(16).toString('hex')`、同一フォルダ内衝突時は再生成）で新規ファイル名を採番。
4. 各ファイルを`.txtenc`化（平文なら暗号化）した上で難読化名で書き込む。**新ファイル永続化(fsync)確認後に旧ファイルを削除**する順序（v1 M6暗号化変換フローと同じ順序、PLANv3 §7.7）。`selfWriteRegistry`へ両パスを登録。
5. `NodeLockBlob{ realMemoName, children, nameMap }`をJSON化→鍵で暗号化(新IV)→Base64化。
6. 起点ノードのMetaTreeNodeを`{ memoName: <起点の難読化名>, expanded:false, children:[], lock:{ kdf, saltB64, ivB64, tagB64, hint, blobCiphertextB64, claimedTokens:[起点+子孫全ての難読化名] } }`へ差し替える。
7. メタJSONをアトミック保存。
8. 全文検索インデックスから該当配下の名前を除去（DESIGNv3 §1.7 Q1。本文は元々`.txtenc`化で既に除外対象）。

### ロック解除フロー（`crypto:unlockNode`）
1. 対象`MetaTreeNode.lock`を読み、salt+KDFパラメータで鍵導出。
2. `blobCiphertextB64`をIV+tagで復号。認証タグ検証失敗時は既存`DECRYPT_FAILED`（本文含め一切返さない）。
3. 復号結果`NodeLockBlob`をパースし、`nodeLockSessionStore`へ`(tabId, lockToken=起点の難読化名)`キーで`{ key, nameMap, tree: children }`を保持。
4. `realMemoName`と`children`から実行時`TreeNode[]`を構築（各ノードに`lockToken`を付与。`encrypted`は実ファイル拡張子から導出=常に`true`）して返却。

### 再ロックフロー（`crypto:relockNode`）
`nodeLockSessionStore`から`(tabId, lockToken)`のエントリを削除するのみ。ファイル操作は一切発生しない（DESIGNv3 §1.5「常駐セッション方式」）。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/main/crypto/nodeLock.ts` — `lockNode`/`unlockNode`/`relockNode`のオーケストレーション、`NodeLockBlob`の構築/パース
- `src/main/crypto/nodeLockSessionStore.ts` — `(tabId, lockToken)`キーでセッション(鍵・nameMap・復号済みchildren)をメモリ保持
- `src/main/crypto/obfuscatedNaming.ts` — 難読化ファイル名生成 + 同一フォルダ内衝突時の再生成
- `src/main/fs/tabService.ts`（拡張）— 突合ロジックが`lock.claimedTokens`に含まれるファイルを孤児判定から除外するよう修正（**必須**、上記参照）
- `src/main/ipc/cryptoHandlers.ts`（拡張）— `lockNode`/`unlockNode`/`relockNode`を追加登録
- レンダラ: ツリー右クリックメニューへ「サブツリーをロック」「ロックを解除」を追加（既存M6暗号化ダイアログの見た目・確認再入力ルールを流用, DESIGNv3 §1.11）
- レンダラ: `src/renderer/components/Tree/TreeRow.tsx`（拡張）— `TreeNode.locked===true`のノードは常に「🔒(ロック中)」表示、`children`は空扱いで描画

## このフェーズのエラーハンドリング
| 事象 | 方針 |
|------|------|
| ロック対象にM6個別暗号化メモが混在 | `LOCK_CONTAINS_ENCRYPTED`。「暗号化済みのメモが含まれています。先に個別の暗号化を解除してください」 |
| ロックパスワード誤り | 既存`DECRYPT_FAILED`を再利用（新規コード不要。本文含め一切返さない） |
| メタ+`.bak`同時消失時のロック名前対応表喪失 | 既存の復旧カスケード（フラット再生成）に合流。名前対応の喪失は許容（追加冗長化なし、DESIGNv3 §1.7 Q3） |

その他（Windows I/Oロック・メタ破損等）は既存方針（v1 [00-core-principles.md](../../00-core-principles.md)）をそのまま適用。ノードロックのファイル操作（難読化名でのリネーム/削除）も既存`selfWriteRegistry`/リトライ機構にそのまま乗る。

## DESIGNv3.md の関連セクション
- ノードロックの対象・強さ・秘匿範囲: §1.1/§1.2。
- 名前・階層構造の秘匿（ブロブ）: §1.3。ディスク上のファイル名秘匿: §1.4。
- 復号方式＝常駐セッション方式（重要な設計判断）: §1.5。
- メタJSON上のデータ構造: §1.6。既存機構(全文検索/監視/バックアップ/復旧カスケード/AutoReName/memo:リンク)への対応: §1.7。
- パスワード忘失時: §1.8。Explorerから見た見え方: §1.9。M6個別暗号化との関係: §1.10。UI操作導線: §1.11（セッション寿命・境界移動はM9で扱う部分を含む）。

## PLANv3.md §7 実装補完事項の関連項目
- **§7.1**（`claimedTokens`の追加、最重要）。
- **§7.7**（難読化変換時のファイル書込み順序＝新ファイル永続化確認後に旧ファイル削除）。

## reviewer/tester への申し送り
- `claimedTokens`が突合ロジックで正しく孤児判定除外に使われているか（=ロック中の子孫ファイルがツリーに一切露出しないか）を**最重要確認項目**とすること。
- ロック実行中クラッシュ時の挙動（難読化ファイル書込み～旧ファイル削除の間、メタJSON保存前後）は v1 M6の暗号化変換フローと同一パターンのため、そちらのレビュー観点を踏襲してよい。
