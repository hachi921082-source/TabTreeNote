# M9 — ノードロック応用（セッション中操作・境界移動・タブ切替）

> **本マイルストーンは実行コストが大きいため、ユーザー判断で3分割済み。developerへの実装依頼は以下の分割後ドキュメントを使うこと（本ファイルは経緯保存・全体像参照用）:**
> - [M9a-node-lock-session-ops.md](M9a-node-lock-session-ops.md) — セッション中の構造変更・入れ子ロック
> - [M9b-node-lock-boundary-move.md](M9b-node-lock-boundary-move.md) — 境界を跨ぐ移動・コピー（M9a必須）
> - [M9c-node-lock-tab-switch.md](M9c-node-lock-tab-switch.md) — タブ切替時のセッション一括破棄
>
> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは [M8-node-lock-core.md](M8-node-lock-core.md) で構築した基盤の上に、ロック解除セッション中の実運用操作
> （構造変更・境界を跨ぐ移動/コピー・タブ切替時の一括破棄・入れ子ロック）を積み上げる。

## ゴール（PLANv3 §2.2/§5.3/§5.4/§5.5）
ロック解除セッション配下で新規作成・リネーム・削除・移動・コピーといった通常のツリー操作が一通り行え、都度ブロブが再暗号化・保存されること。ロック境界を跨ぐ移動・コピー（「一方通行の金庫」方式）、タブ切替時のセッション一括破棄、入れ子ロック（セッション内でさらに別ノードをロック）までが動く状態がゴール。

## 依存関係
- 先行: **[M8](M8-node-lock-core.md) 必須**（ロック/解除/再ロックの基盤、`nodeLockSessionStore`、`claimedTokens`対応済みの突合ロジック）。

## このフェーズで扱う IPC チャネル（PLANv3 §2.1/§2.2）
| チャネル | 変更内容 |
|----------|----------|
| `crypto:lockNode` / `crypto:unlockNode` | M8で実装済みの引数に `lockContext?` を追加し、既に別ロックの解除セッション内にあるノードを起点にロック/解除できるようにする（入れ子ロック、PLANv3 §7.4） |
| `crypto:relockAllInTab`（新規） | `{ tabId }` → `Result<void>`。指定タブに紐づく**全**ロックセッションを一括破棄（タブ切替時用）。DESIGNv3 §1.11が要求する「タブ離脱時の即時セッション破棄」を満たすための実装用IPC（一括化という実装方式自体はPLANv3判断、§7.6） |
| `memo:read` / `memo:save` / `memo:create` / `memo:rename` / `memo:delete` / `memo:duplicate` / `tree:updateStructure` | 共通の任意引数 `lockContext?: { lockToken: string }` を追加。指定時はロックセッションが保持する実行時構造・`nameMap`を介して`memoName`を解決する（PLANv3 §2.2） |
| `memo:move` | `srcLockContext?`/`destLockContext?` を追加し、境界を跨ぐ移動・コピーのルール（下記表）を適用する |

## このフェーズで扱う型/データ構造
```ts
type NodeLockErrorCode =
  | 'LOCK_CONTAINS_ENCRYPTED'  // （M8既出）境界跨ぎ「外→内」時にも同じチェックを適用
  | 'LOCK_SESSION_NOT_FOUND'   // （M8既出）
  | 'LOCK_BOUNDARY_VIOLATION'; // ★新規: ロック解除中配下→外、または別ロックへの移動・コピー試行
```
`memo:move`引数拡張: `{ srcTabId, memoNames[], destTabId, destPosition, copy, srcLockContext?: { lockToken: string }, destLockContext?: { lockToken: string } }`。

## このフェーズで扱う処理フロー（PLANv3 §5.3/§5.4/§5.5）

### セッション中の構造変更フロー（`lockContext`指定時の`memo:*`/`tree:updateStructure`共通処理）
1. 対象セッションを`nodeLockSessionStore`から取得。無ければ`LOCK_SESSION_NOT_FOUND`。
2. セッションが保持する実行時構造上でオペレーションを実施する:
   - 新規作成: 新規難読化名を採番し`claimedTokens`へ追加、`nameMap`へ登録。
   - 削除: 実ファイル削除+`claimedTokens`/`nameMap`から除去。
   - リネーム: `nameMap`のキー（realName側）のみ差し替え。難読化ファイル名は不変。
   - 起点ノード自身のリネーム: `NodeLockBlob.realMemoName`を更新（DESIGNv3 §1.5）。
3. 実ファイル操作は難読化ファイル名に対して行う（既存の同期順序・`selfWriteRegistry`登録を踏襲）。
4. 更新後の`NodeLockBlob`を同一鍵・新IVで再暗号化→`lock.blobCiphertextB64`/`claimedTokens`を更新→メタJSONをアトミック保存（**操作の都度、即座に**再暗号化・アトミック保存する。「再ロック時にまとめて確定保存」は途中クラッシュで全構造変更が失われるため不可、DESIGNv3 §1.5）。

### 境界を跨ぐ移動・コピー（`memo:move`拡張、DESIGNv3 §1.12）
`memo:move`の引数に`srcLockContext?`/`destLockContext?`を追加して判定する。判定結果は以下の通り（★PLANv3実装補完、別ロック間の行はPLANv3 §7.5）:

| src（移動元） | dest（移動先） | 結果 |
|---|---|---|
| 通常（`srcLockContext`未指定） | 通常（`destLockContext`未指定） | 許可（既存v1と同じ通常の移動） |
| 通常 | ロック解除セッション配下（`destLockContext`指定） | 許可（外→内、DESIGNv3 §1.12） |
| ロック解除セッション配下（`srcLockContext`指定） | 通常 | **禁止**（`LOCK_BOUNDARY_VIOLATION`。内→外） |
| ロックA配下 | ロックB配下（`lockToken`が異なる） | **禁止**（`LOCK_BOUNDARY_VIOLATION`。別ロック間） |
| ロックA配下 | ロックA配下（同一`lockToken`） | 許可（境界を跨がないため制限なし。上記「セッション中の構造変更フロー」として処理） |

補足:
- **「許可（外→内）」時**: 対象に個別暗号化`.txtenc`が含まれる場合は`LOCK_CONTAINS_ENCRYPTED`。許可時は対象を難読化名へリネーム+暗号化し、dest側セッションの`nameMap`/`children`/`claimedTokens`へ組み込む（上記フローと同じ再暗号化保存を実行）。
- **「禁止」全般**: UIはドロップ自体を受け付けない（レンダラでも事前ブロックし、IPC側でも同一ルールを再検証する二重防御。「一方通行の金庫」は実装上の制約ではなく設計上意図した恒久的な制約、DESIGNv3 §1.12）。保護範囲に一度入ったものを外へ出す唯一の手段は**削除**。

### タブ切替時のセッション一括破棄
レンダラの既存タブ切替処理（`requestCloseCurrentMemo`による未保存編集確認が先に完走した後）から、直前タブに対して`crypto:relockAllInTab{tabId}`を呼び出し、当該タブに紐づく全ロックセッションを一括破棄する。**順序厳守**（DESIGNv3 §1.11／PLANv3 §7 未保存編集の扱い）: dirty確認→保存/破棄確定→タブ切替→セッション破棄。ノードロック専用の新しい確認ダイアログは追加しない（既存の未保存編集確認フローがそのまま適用範囲を包含する）。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/main/ipc/cryptoHandlers.ts`（拡張）— `relockAllInTab`を追加登録
- `src/main/ipc/memoHandlers.ts`（拡張）— 各ハンドラで`lockContext`の有無により解決先（通常ツリー/ロックセッション）を分岐、`memo:move`の境界跨ぎ判定を実装
- レンダラ: `src/renderer/components/Tree/TreeRow.tsx`（拡張）— `lockToken`配下ノードはドラッグアウト（セッション外への移動先候補としてのドロップ）を拒否
- レンダラ: 既存タブ切替処理（拡張）— `requestCloseCurrentMemo`完走後に`crypto:relockAllInTab`を呼び出す配線を追加

## このフェーズのエラーハンドリング
| 事象 | 方針 |
|------|------|
| ロック解除中配下→外、または別ロックへの移動・コピー試行 | `LOCK_BOUNDARY_VIOLATION`。UIはドロップ自体を無効化（事前ブロック）し、IPC側でも同一ルールを再検証する二重防御 |
| `lockContext`指定だがセッション失効/未存在 | `LOCK_SESSION_NOT_FOUND`。UIはツリーを再取得しロック中(🔒)表示へ戻す。エラーコードを`_EXPIRED`/`_NOT_FOUND`に分割しない（ノードロックセッションにタイムアウトが無く「ある/無い」の二値のみのため、PLANv3 §6） |
| 境界跨ぎ移動元にM6個別暗号化メモが混在 | `LOCK_CONTAINS_ENCRYPTED`（M8と同一コード） |

## DESIGNv3.md の関連セクション
- UI操作・セッションの寿命（複数同時セッション・タイムアウト無し・タブ離脱で即破棄・未保存編集の扱い）: §1.11。
- ロック境界をまたぐ移動・コピー（「一方通行の金庫」方式への変更経緯を含む）: §1.12。

## PLANv3.md §7 実装補完事項の関連項目
- **§7.2**（`lockContext`方式によるIPC拡張）。
- **§7.3**（名前の一意性スコープ＝ロック単位でのみ一意）。
- **§7.4**（入れ子ロックの許可）。
- **§7.5**（異なるロックセッション間の移動禁止）。
- **§7.6**（`crypto:relockAllInTab`の新設）。

## reviewer/tester への申し送り
- 「一方通行の金庫」の禁止ルール（内→外、別ロック間）が**レンダラのドロップ拒否とIPC側の検証の両方**で効いているか（片方だけだと事故防止にならない）を確認すること。
- タブ切替時、未保存編集がある状態でセッション破棄が編集確認より先に走ってしまっていないか（順序: dirty確認→保存/破棄確定→タブ切替→セッション破棄）を重点確認すること。
