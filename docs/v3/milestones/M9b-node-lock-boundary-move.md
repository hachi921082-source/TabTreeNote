# M9b — ノードロック応用（境界を跨ぐ移動・コピー）

> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは、当初の [M9-node-lock-session-ops.md](M9-node-lock-session-ops.md)（実行コストが大きいためユーザー判断で3分割）のうち、
> **ロック境界を跨ぐ移動・コピー（「一方通行の金庫」方式）**を扱う。

## ゴール（PLANv3 §5.4）
`memo:move` にロック境界の判定を追加し、「通常領域→セッション配下（外→内）」のみ許可、「セッション配下→通常領域・別セッション配下（内→外、別ロック間）」は`LOCK_BOUNDARY_VIOLATION`で禁止する「一方通行の金庫」方式を実装する。レンダラのドラッグ&ドロップ事前拒否とIPC側の再検証、両方の防御が効いている状態がゴール。

## 依存関係
- 先行: **[M8](M8-node-lock-core.md) 必須**（ロック/解除/再ロックの基盤）、**[M9a](M9a-node-lock-session-ops.md) 必須**（「外→内」許可時に対象をセッションの`nameMap`/`children`/`claimedTokens`へ組み込む処理は、M9aの「セッション中の構造変更フロー」の再暗号化保存をそのまま利用するため）。

## このフェーズで扱う IPC チャネル（PLANv3 §2.1）
| チャネル | 変更内容 |
|----------|----------|
| `memo:move` | 引数に `srcLockContext?: { lockToken: string }` / `destLockContext?: { lockToken: string }` を追加し、境界を跨ぐ移動・コピーのルール（下記表）を適用する |

## このフェーズで扱う型/データ構造
```ts
type NodeLockErrorCode =
  | 'LOCK_CONTAINS_ENCRYPTED'  // （M8既出）境界跨ぎ「外→内」時にも同じチェックを適用
  | 'LOCK_BOUNDARY_VIOLATION'; // ★新規: ロック解除中配下→外、または別ロックへの移動・コピー試行
```
`memo:move`引数拡張: `{ srcTabId, memoNames[], destTabId, destPosition, copy, srcLockContext?: { lockToken: string }, destLockContext?: { lockToken: string } }`。

## このフェーズで扱う処理フロー（PLANv3 §5.4、DESIGNv3 §1.12）

### 境界を跨ぐ移動・コピーの判定表（★PLANv3実装補完。別ロック間の行はPLANv3 §7.5）
| src（移動元） | dest（移動先） | 結果 |
|---|---|---|
| 通常（`srcLockContext`未指定） | 通常（`destLockContext`未指定） | 許可（既存v1と同じ通常の移動） |
| 通常 | ロック解除セッション配下（`destLockContext`指定） | 許可（外→内、DESIGNv3 §1.12） |
| ロック解除セッション配下（`srcLockContext`指定） | 通常 | **禁止**（`LOCK_BOUNDARY_VIOLATION`。内→外） |
| ロックA配下 | ロックB配下（`lockToken`が異なる） | **禁止**（`LOCK_BOUNDARY_VIOLATION`。別ロック間） |
| ロックA配下 | ロックA配下（同一`lockToken`） | 許可（境界を跨がないため制限なし。M9aの「セッション中の構造変更フロー」として処理） |

補足:
- **「許可（外→内）」時**: 対象に個別暗号化`.txtenc`が含まれる場合は`LOCK_CONTAINS_ENCRYPTED`。許可時は対象を難読化名へリネーム+暗号化し、dest側セッションの`nameMap`/`children`/`claimedTokens`へ組み込む（M9aと同じ再暗号化保存を実行）。
- **「禁止」全般**: UIはドロップ自体を受け付けない（レンダラでも事前ブロックし、IPC側でも同一ルールを再検証する二重防御。「一方通行の金庫」は実装上の制約ではなく設計上意図した恒久的な制約、DESIGNv3 §1.12）。保護範囲に一度入ったものを外へ出す唯一の手段は**削除**。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/main/ipc/memoHandlers.ts`（拡張）— `memo:move`の境界跨ぎ判定を実装
- `src/renderer/components/Tree/TreeRow.tsx`（拡張）— `lockToken`配下ノードはドラッグアウト（セッション外・別セッションへの移動先候補としてのドロップ）を拒否

## このフェーズのエラーハンドリング
| 事象 | 方針 |
|------|------|
| ロック解除中配下→外、または別ロックへの移動・コピー試行 | `LOCK_BOUNDARY_VIOLATION`。UIはドロップ自体を無効化（事前ブロック）し、IPC側でも同一ルールを再検証する二重防御 |
| 境界跨ぎ移動元（外→内）にM6個別暗号化メモが混在 | `LOCK_CONTAINS_ENCRYPTED`（M8と同一コード） |

## DESIGNv3.md の関連セクション
- ロック境界をまたぐ移動・コピー（「一方通行の金庫」方式への変更経緯を含む）: §1.12。

## PLANv3.md §7 実装補完事項の関連項目
- **§7.5**（異なるロックセッション間の移動禁止）。

## reviewer/tester への申し送り
- 「一方通行の金庫」の禁止ルール（内→外、別ロック間）が**レンダラのドロップ拒否とIPC側の検証の両方**で効いているか（片方だけだと事故防止にならない）を**最重要確認項目**とすること。
- 「外→内」許可時、dest側セッションの`nameMap`/`children`/`claimedTokens`への組み込みがM9aの再暗号化保存フローと矛盾なく行われているか確認すること。
