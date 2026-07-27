# M9a — ノードロック応用（セッション中の構造変更・入れ子ロック）

> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは、当初の [M9-node-lock-session-ops.md](M9-node-lock-session-ops.md)（実行コストが大きいためユーザー判断で3分割）のうち、
> **ロック解除セッション配下での通常のツリー操作（新規作成/リネーム/削除/複製）と、入れ子ロック**を扱う。
> 境界を跨ぐ移動・コピーは [M9b-node-lock-boundary-move.md](M9b-node-lock-boundary-move.md)、タブ切替時の一括破棄は [M9c-node-lock-tab-switch.md](M9c-node-lock-tab-switch.md) で扱う。

## ゴール（PLANv3 §2.2/§5.3）
ロック解除セッション配下で `memo:read`/`memo:save`/`memo:create`/`memo:rename`/`memo:delete`/`memo:duplicate`/`tree:updateStructure` の各操作を、通常のタブ直下ツリーと同じ感覚で行えるようにする。操作の都度、セッションが保持する `NodeLockBlob` を再暗号化しメタJSONへアトミック保存する。加えて、セッション配下でさらに別ノードをロックする「入れ子ロック」（`crypto:lockNode`/`crypto:unlockNode` への `lockContext` 追加）が動く状態がゴール。

## 依存関係
- 先行: **[M8](M8-node-lock-core.md) 必須**（`nodeLockSessionStore`、ロック/解除/再ロックの基盤、`claimedTokens`対応済みの突合ロジック）。
- 後続: [M9b](M9b-node-lock-boundary-move.md)（境界を跨ぐ移動）は「外→内」許可時に本マイルストーンと同じ再暗号化保存フローを使うため、本マイルストーン完了が前提。[M9c](M9c-node-lock-tab-switch.md)（タブ切替一括破棄）はM8のみに依存し本マイルストーンと直接の依存はないが、レビュー往復を分散させる目的で本マイルストーン完了後の着手を推奨。

## このフェーズで扱う IPC チャネル（PLANv3 §2.1/§2.2）
| チャネル | 変更内容 |
|----------|----------|
| `memo:read` / `memo:save` / `memo:create` / `memo:rename` / `memo:delete` / `memo:duplicate` / `tree:updateStructure` | 共通の任意引数 `lockContext?: { lockToken: string }` を追加。指定時はロックセッションが保持する実行時構造・`nameMap`を介して`memoName`を解決する（PLANv3 §2.2）。省略時はM8実装済みの通常挙動のまま変化なし |
| `crypto:lockNode` / `crypto:unlockNode` | M8で実装済みの引数に `lockContext?` を追加し、既に別ロックの解除セッション内にあるノードを起点にロック/解除できるようにする（入れ子ロック、PLANv3 §7.4） |

## このフェーズで扱う型/データ構造
```ts
type NodeLockErrorCode =
  | 'LOCK_CONTAINS_ENCRYPTED'  // （M8既出）
  | 'LOCK_SESSION_NOT_FOUND';  // （M8で型は追加済みだが未使用。本マイルストーンで実際に返す経路が生まれる
                                //   ＝lockContextで指定されたセッションが存在しない/失効済み）
```
`memo:*`/`tree:updateStructure` の `lockContext` 引数は `{ lockToken: string }` のみ（`tabId` は既存引数をそのまま流用）。

## このフェーズで扱う処理フロー（PLANv3 §5.3）

### セッション中の構造変更フロー（`lockContext`指定時の`memo:*`/`tree:updateStructure`共通処理）
1. 対象セッションを`nodeLockSessionStore`から取得。無ければ`LOCK_SESSION_NOT_FOUND`。
2. セッションが保持する実行時構造上でオペレーションを実施する:
   - 新規作成: 新規難読化名を採番し`claimedTokens`へ追加、`nameMap`へ登録。
   - 削除: 実ファイル削除+`claimedTokens`/`nameMap`から除去。
   - リネーム: `nameMap`のキー（realName側）のみ差し替え。難読化ファイル名は不変。
   - 起点ノード自身のリネーム: `NodeLockBlob.realMemoName`を更新（DESIGNv3 §1.5）。
3. 実ファイル操作は難読化ファイル名に対して行う（既存の同期順序・`selfWriteRegistry`登録を踏襲）。
4. 更新後の`NodeLockBlob`を同一鍵・新IVで再暗号化→`lock.blobCiphertextB64`/`claimedTokens`を更新→メタJSONをアトミック保存（**操作の都度、即座に**再暗号化・アトミック保存する。「再ロック時にまとめて確定保存」は途中クラッシュで全構造変更が失われるため不可、DESIGNv3 §1.5）。

### 名前の一意性スコープ（PLANv3 §7.3）
ロック配下の`memoName`（`NodeLockBlob.realMemoName`/`children`内）は**ブロブ内（同一ロックの兄弟間）でのみ一意であればよく、タブ全体の名前空間とは独立**。重複チェック（`memo:create`/`memo:rename`の`NAME_DUPLICATE`判定）は、`lockContext`指定時はそのセッション内の兄弟のみを対象にする（タブ直下の可視名や他セッションの実名と衝突しても問題ない）。

> 参考: M8のtester検証で見つかった `M8-T1-R1-01`（アクティブなセッションが可視化している実名との重複チェック漏れ）は、`lockContext`省略時（通常のタブ直下操作）が誤ってセッション展開中の実名と衝突判定してしまう問題への対処であり、本フェーズが実装する「セッション内一意性」とは別の対応。既に`memoHandlers.ts`の`isMemoNameTaken`/`collectActiveSessionRealNames`として実装済みのため、本マイルストーンで重複実装しないこと。

### 入れ子ロック（PLANv3 §7.4）
`NodeLockBlob.children`の型が`MetaTreeNode[]`であり`MetaTreeNode.lock`は元々再帰的に持てるため、型構造上は特別な実装が不要。本マイルストーンで実装が必要なのは、`crypto:lockNode`/`crypto:unlockNode`が`lockContext`を受け取った場合に、対象セッションの実行時構造（`children`）上で起点ノードを探してロック/解除処理を行う分岐のみ（ファイル操作・ブロブ暗号化ロジック自体はM8のものをそのまま再利用）。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/main/ipc/memoHandlers.ts`（拡張）— 各ハンドラで`lockContext`の有無により解決先（通常ツリー/ロックセッション）を分岐
- `src/main/ipc/cryptoHandlers.ts`（拡張）— `lockNode`/`unlockNode`に`lockContext`引数を追加し、セッション配下起点での入れ子ロックに対応
- `src/main/crypto/nodeLockSessionStore.ts`（拡張の可能性）— セッション内構造変更・入れ子セッションの保持方法に応じて必要なら拡張

## このフェーズのエラーハンドリング
| 事象 | 方針 |
|------|------|
| `lockContext`指定だがセッション失効/未存在 | `LOCK_SESSION_NOT_FOUND`。UIはツリーを再取得しロック中(🔒)表示へ戻す。エラーコードを`_EXPIRED`/`_NOT_FOUND`に分割しない（ノードロックセッションにタイムアウトが無く「ある/無い」の二値のみのため、PLANv3 §6） |

## DESIGNv3.md の関連セクション
- 復号方式＝常駐セッション方式、操作の都度即座に再暗号化・保存: §1.5。
- UI操作・セッションの寿命（複数同時セッション・入れ子）: §1.11。

## PLANv3.md §7 実装補完事項の関連項目
- **§7.2**（`lockContext`方式によるIPC拡張）。
- **§7.3**（名前の一意性スコープ＝ロック単位でのみ一意）。
- **§7.4**（入れ子ロックの許可）。

## reviewer/tester への申し送り
- 構造変更操作の都度、即座に再暗号化・アトミック保存されているか（バッチ化されていないか）を重点確認すること。クラッシュ耐性がDESIGNv3 §1.5の確定要件。
- 入れ子ロックの`lockContext`解決チェーンが正しいか（誤って親セッションと子セッションの`nameMap`/`claimedTokens`が混同されないか）を確認すること。
- 名前の一意性チェックが「ロック単位」に正しく閉じているか（タブ全体や他セッションの名前と不要に衝突判定していないか）を確認すること。M8-T1-R1-01との役割の違い（本マイルストーン冒頭の注記参照）を踏まえること。
