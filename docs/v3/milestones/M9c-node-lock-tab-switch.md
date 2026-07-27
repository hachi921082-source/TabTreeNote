# M9c — ノードロック応用（タブ切替時のセッション一括破棄）

> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは、当初の [M9-node-lock-session-ops.md](M9-node-lock-session-ops.md)（実行コストが大きいためユーザー判断で3分割）のうち、
> **タブ切替時のロック解除セッション一括破棄**を扱う。3分割の中では最小規模。

## ゴール（PLANv3 §5.5）
タブを切り替えた際、直前タブに紐づく全てのロック解除セッションを`crypto:relockAllInTab`で一括破棄する。DESIGNv3 §1.11が要求する「タブ離脱時の即時セッション破棄」を、既存の未保存編集確認フローの順序を壊さずに実現することがゴール。

## 依存関係
- 先行: **[M8](M8-node-lock-core.md) 必須**（`crypto:relockNode`と対称の破棄ロジック、`nodeLockSessionStore`）。
- [M9a](M9a-node-lock-session-ops.md)/[M9b](M9b-node-lock-boundary-move.md)とは設計上独立（`lockContext`によるセッション内操作や境界移動を必要としない）。ただしレビュー往復を分散させる目的で、M9a完了後の着手を推奨（必須ではない）。

## このフェーズで扱う IPC チャネル（PLANv3 §2.1）
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `crypto:relockAllInTab`（新規） | `{ tabId }` | `Result<void>` | 指定タブに紐づく**全**ロックセッションを一括破棄（タブ切替時用）。DESIGNv3 §1.11が要求する「タブ離脱時の即時セッション破棄」を満たすための実装用IPC（一括化という実装方式自体はPLANv3判断、§7.6） |

## このフェーズで扱う処理フロー（PLANv3 §5.5）

### タブ切替時のセッション一括破棄
レンダラの既存タブ切替処理（`requestCloseCurrentMemo`による未保存編集確認が先に完走した後）から、直前タブに対して`crypto:relockAllInTab{tabId}`を呼び出し、当該タブに紐づく全ロックセッションを一括破棄する。**順序厳守**（DESIGNv3 §1.11）: dirty確認→保存/破棄確定→タブ切替→セッション破棄。ノードロック専用の新しい確認ダイアログは追加しない（既存の未保存編集確認フローがそのまま適用範囲を包含する）。

メインプロセス側の`relockAllInTab`自体は、`nodeLockSessionStore`から`tabId`に紐づく全エントリを削除するのみ（`crypto:relockNode`のループ相当。ファイル操作は一切発生しない）。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/main/ipc/cryptoHandlers.ts`（拡張）— `relockAllInTab`を追加登録
- レンダラ: 既存タブ切替処理（拡張）— `requestCloseCurrentMemo`完走後に`crypto:relockAllInTab`を呼び出す配線を追加

## このフェーズのエラーハンドリング
新規のエラーコードは無い。対象タブにセッションが1件も無い場合は何もせず成功扱い（冪等）。

## DESIGNv3.md の関連セクション
- UI操作・セッションの寿命（複数同時セッション・タイムアウト無し・タブ離脱で即破棄・未保存編集の扱い）: §1.11。

## PLANv3.md §7 実装補完事項の関連項目
- **§7.6**（`crypto:relockAllInTab`の新設）。

## reviewer/tester への申し送り
- タブ切替時、未保存編集がある状態でセッション破棄が編集確認より先に走ってしまっていないか（順序: dirty確認→保存/破棄確定→タブ切替→セッション破棄）を**最重要確認項目**とすること。
- タブ切替をキャンセルした場合（未保存編集確認でキャンセルを選んだ場合）にセッションが誤って破棄されていないかも確認すること。
