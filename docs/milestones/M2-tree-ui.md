# M2 — ツリー UI + メタ同期

> 派生ドキュメント。正本は [PLAN.md](../../PLAN.md) / [DESIGN.md](../../DESIGN.md)。横断ルールは [00-core-principles.md](../00-core-principles.md)、型は [data-model.md](../data-model.md)。

## ゴール（PLAN §7 M2）
仮想化ツリー、開閉/複数選択、追加位置、リネーム/削除（ごみ箱+フォールバック）/複製/移動・コピー、DND、DESIGN §3.2 同期順序の実装、サニタイズ UX（PLAN §5.9）。

## 依存関係
- 先行: M1（ファイル層コア）。M1 の `metaStore`/`memoFileService`/同期順序基盤の上に UI と残りのメモ操作を構築する。

## このフェーズで扱う IPC チャネル（PLAN §2.1 全体 / §2.2 全体）
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `tab:rename` | `{ tabId, newName }` | `Result` | フォルダリネーム。重複拒否・サニタイズ・同期順序 |
| `tab:remove` | `{ tabId, deleteFolder? }` | `Result` | タブ登録解除（既定はフォルダ削除しない）。削除指定時はごみ箱送り |
| `tab:reorder` | `{ orderedTabIds }` | `Result` | タブ並べ替え。`AppSettings.tabs` **配列自体を並べ替えて**アトミック保存（配列順が並び順の唯一の正本。`order` フィールドは持たない, Fix7） |
| `memo:delete` | `{ tabId, memoNames[], forceDirect? }` | `Result` | 既定はごみ箱送り。失敗時は `evt:trashFallback` 通知 → UI 確認 → **ユーザー承諾後に `forceDirect:true` で再 invoke** し直接 `fs.unlink`（無確認直接削除はしない） |
| `memo:duplicate` | `{ tabId, memoName }` | `MemoInfo` | 複製 |
| `memo:move` | `{ srcTabId, memoNames[], destTabId, destPosition, copy }` | `Result` | タブ間/タブ内移動・コピー（Ctrl でコピー） |
| `tree:updateStructure` | `{ tabId, treeStructure }` | `Result` | ツリー順序・階層・開閉・ラベルのメタ更新（アトミック保存） |

（M1 で実装した `tab:register`/`create`/`openTree`、`memo:read`/`save`/`create`/`rename` もここで UI から本格利用する。）
通知: `evt:trashFallback`（ごみ箱送り失敗 → UI で直接削除確認）を扱う（PLAN §2.7）。

## このフェーズで扱う型/データ構造
- ツリー表示は `TreeSnapshot` / `TreeNode`（実行時・`encrypted` 付き・readonly）。編集後の永続化は `MetaTreeNode` へ変換して保存。[data-model.md](../data-model.md) §1・§4 参照。
- ラベル `Label`、メモ毎エディタ設定 `MemoEditorSettings`（§4）。
- `MemoInfo`（create/duplicate/move の返却）。
- **重要**: メタ JSON へ書き出すのは常に `MetaTreeNode`（`encrypted` を持たない）。UI の `TreeNode` をそのままシリアライズしない（真実源は拡張子 `.txtenc`、PLAN §8-1）。

## このフェーズで扱う処理フロー

### リネーム / 移動 / コピー / 複製の同期順序（PLAN §5.3）
「実ファイルとメタの両方に影響する操作」は必ず同期順序に従う（[00-core-principles.md](../00-core-principles.md) §3）:
1. **ストア更新**（重複チェック・サニタイズ先行。NG なら即エラー、ファイル操作しない）。
2. **実ファイル操作**（`fs.rename` 等）+ 直前に `selfWriteRegistry` へ登録。`retry` 適用。
3. **直後にメタ JSON アトミック保存**。
4. インデックス経路①でメモ名キーを更新（インデックス本体は M3）。
- **移動/コピー（`memo:move`）**: 複数ファイル + 2 つのタブのメタに影響。各ファイル操作を予約登録し、両タブのメタを操作完了直後にアトミック保存。コピー時（Ctrl）は元を残す。
- クラッシュ時の隙は復旧カスケードが安全網（受容済みトレードオフ）。

### 削除（ごみ箱送り + フォールバック）（DESIGN §2.6 / PLAN §2.2）
- `memo:delete` 既定はごみ箱送り（`shell.trashItem`）。失敗時（ネットワークドライブ/権限）は `TRASH_FAILED` → `evt:trashFallback` 通知 → UI で「直接削除しますか？」確認 → **承諾時のみ** `forceDirect:true` で再 invoke し `fs.unlink`。**無確認での直接削除はしない**。→ [00-core-principles.md](../00-core-principles.md) §8。

### 追加位置（DESIGN §2.2）
- `memo:create` の position: before / after / child / first / last。

### 名前サニタイズ UX（PLAN §5.9 / DESIGN §3.1）
- レンダラ入力欄で即時バリデーションメッセージ。`/` 等は `-`/`_` への置換候補をワンクリック提示。
- タブ名は重複禁止（大文字小文字・正規化後で比較）。メモ名は同一タブ内で `.txt`/`.txtenc` 統一空間で重複禁止。
- 長パス（260 字超）検出は `LONG_PATH` 警告。→ 全体は [00-core-principles.md](../00-core-principles.md) §11。

## このフェーズで扱うディレクトリ/ファイル（PLAN §3）
- `src/main/fs/trash.ts` — `shell.trashItem` + フォールバック
- `src/main/fs/memoFileService.ts` — move/duplicate/delete の追加
- `src/main/ipc/tabHandlers.ts` / `memoHandlers.ts` の拡張
- レンダラ `src/renderer/components/Tree/` — 仮想化ツリー・DND・開閉・複数選択
- レンダラ `src/renderer/components/TabBar/`
- レンダラ `src/renderer/components/dialogs/` — 削除確認・サニタイズ提案
- レンダラ `src/renderer/store/` — UI 状態（Zustand 等）

## このフェーズのエラーハンドリング（[00-core-principles.md](../00-core-principles.md) §8）
関連行: 「ごみ箱送り失敗」「名前重複/禁止文字」「Windows ロック」「予期せぬ例外」。同期順序のクラッシュ安全網はメタ復旧カスケード（§9）。

## DESIGN.md の関連セクション
- メモのツリー管理（追加位置・移動・複製・複数選択・DND）: DESIGN §2.2。
- タブ管理（重複禁止・並べ替え・DND 登録）: DESIGN §2.1。
- 削除・ごみ箱・フォールバック: DESIGN §2.6。
- 同期順序・堅牢性: DESIGN §3.2。
- サニタイズ: DESIGN §3.1。

## PLAN §8 整合メモの関連項目
- **メモ 1**（暗号化状態の真実源=拡張子 `.txtenc`。メタ側に暗号フラグを持たない。ツリー表示の暗号アイコンは走査時の拡張子から導出。→ 永続化は `MetaTreeNode`、UI は `TreeNode`）。
- **メモ 6**（リネーム/移動/コピー/複製操作の外部変更競合は非検出＝受容済みリスク。M1 と共通）。
