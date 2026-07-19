# M1 — ファイル層コア（平文）

> 派生ドキュメント。正本は [PLAN.md](../../PLAN.md) / [DESIGN.md](../../DESIGN.md)。横断ルールは [00-core-principles.md](../00-core-principles.md)、型は [data-model.md](../data-model.md)。

## ゴール（PLAN §7 M1）
`atomicWrite`+`.bak`、`tempNaming`、`retry`、`encoding`（2 段フォールバック）、`eol`（検出/復元）、`memoFileService` の read/save、`tabService`（フォルダ登録・直下走査・リンク無視）、`metaStore`（読書き+復旧カスケード）を実装。IPC は tab/memo の基本。→ **平文メモの開く/編集/保存が一通り動く**。

## 依存関係
- 先行: M0（足場）。**M1 は全ての土台**（PLAN §7 依存関係）。

## このフェーズで扱う IPC チャネル（PLAN §2.1 / §2.2）
タブ（§2.1）は register/create を中心に、メモ（§2.2）は read/save/create/rename を中心に実装（ツリー構造更新・移動・削除の一部は M2 と分担）。

| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `tab:list` | – | `TabInfo[]` | 登録タブ一覧（アプリ設定の登録順） |
| `tab:register` | `{ folderPath }` | `TabInfo` | 既存フォルダをタブ登録。表示名重複チェック（DESIGN §2.1） |
| `tab:create` | `{ parentDir, name }` | `TabInfo` | 新規フォルダ作成+タブ登録。名前サニタイズ+重複拒否 |
| `tab:openTree` | `{ tabId }` | `TreeSnapshot` | タブのツリー（メタ+実ファイル突合結果）を取得 |
| `memo:read` | `{ tabId, memoName }` | `MemoReadResult` | 平文 `.txt` 読込。本文+検出エンコーディング+検出改行コード。`.txtenc` はここでは本文を返さず暗号化フラグのみ |
| `memo:readWithEncoding` | `{ tabId, memoName, encoding }` | `MemoReadResult` | エンコーディング明示指定で開き直す（DESIGN §2.3） |
| `memo:save` | `{ tabId, memoName, contentLF, eol, encoding, expectedHash? }` | `SaveResult` | 平文保存。改行コード復元→エンコード→アトミック書込+`.bak`。`expectedHash` で外部変更競合検出 |
| `memo:create` | `{ tabId, name, position, anchorMemoName? }` | `MemoInfo` | メモ新規作成（追加位置: before/after/child/first/last, DESIGN §2.2） |
| `memo:rename` | `{ tabId, oldName, newName }` | `Result` | メモ+ファイルのリネーム。同期順序 |

## このフェーズで扱う型/データ構造
主に [data-model.md](../data-model.md) の以下を使用:
- `MemoReadResult` / `Eol` / `SaveResult` / `TabInfo` / `MemoInfo`（§4）
- `TabMeta` / `MetaTreeNode`（永続化用）/ `TreeNode`（実行時用）/ `TreeSnapshot`（§4）
- メタ JSON `.tabtreenote.json`（§1）・突合ロジック（メタ `MetaTreeNode[]` と実ファイル走査を突合して `TreeNode[]` を構築、`encrypted` は拡張子から導出）
- **重要**: メタ JSON へ書き出すのは常に `MetaTreeNode`（`encrypted` を持たない）。`TreeNode` をそのままシリアライズしない。

## このフェーズで扱う処理フロー

### 起動時初期化（PLAN §5.1）— M1 で扱う範囲
1. アプリ設定 JSON を読込（破損時は復旧カスケード、無ければ既定生成）。
2. ウィンドウ復元（位置/サイズ/テーマ/ツリー幅）。
3. 登録タブ一覧を取得。各タブフォルダについて `metaStore.load`（メタ JSON 読込 → 復旧カスケード → 実ファイル突合）。
（検索インデックス構築=M3、chokidar 監視=M4、最後に開いていたメモ復元=以降。）

### 平文メモの保存フロー（PLAN §5.2 / `memo:save`）
1. レンダラ: CodeMirror の `doc.toString()`（LF 正規化済み）と保持していた元の改行コード種別 `eol`、`expectedHash`（開いた時点/前回保存時のハッシュ）を IPC へ。
2. メイン: **競合チェック** — 現在のディスク実体のハッシュを計算し `expectedHash` と比較。不一致なら `evt:conflict` を発火し保存中断（競合解決 UI へ。UI 本体は M2/M4）。
3. `eol.restore(contentLF, eol)` で改行コードを復元（DESIGN §2.3 必須処理）。
4. `encoding.encode(text, encoding)` でバイト列化（既定 UTF-8）。
5. `atomicWrite` を呼ぶ。**自己書き込み予約は `atomicWrite` 内部で** target・`.bak` の両パスについて期待 mtime/サイズ/ハッシュを `selfWriteRegistry` に登録（呼び出し側任せにしない）。※`selfWriteRegistry` の実消費は M4 だが、登録の一元化構造は M1 の `atomicWrite` に組み込む。
6. `atomicWrite`: **temp（プレフィックス付き）へ書込 → fsync → 旧 target を `.bak` へ rename → temp を target へ rename**。各操作 `retry`（EBUSY/EPERM 対策）。→ 詳細は [00-core-principles.md](../00-core-principles.md) §2。
7. 成功後、インデックス経路①で本文反映（M3 以降で有効化）。
8. `SaveResult{ savedHash }` を返却。レンダラは以後の競合判定用に保持。

### リネーム同期順序（PLAN §5.3 / `memo:rename`）
1. **ストア更新**: `oldName`→`newName` に参照差し替え（重複チェック・サニタイズを先に。NG なら即エラー、ファイル操作しない）。
2. **実ファイル操作**: `fs.rename`。直前に `selfWriteRegistry` へ old(unlink 相当)/new(add 相当) を登録。`retry` 適用。
3. **直後にメタ JSON アトミック保存**。
→ 同期順序の全体は [00-core-principles.md](../00-core-principles.md) §3。

### メタ破損復旧カスケード（PLAN §5.7）
[00-core-principles.md](../00-core-principles.md) §9 参照（`.bak`→フラット再生成→`evt:metaRecovered` 通知）。M1 で `metaStore` に実装する。

### 文字コード / 改行コード（DESIGN §2.3）
- **文字コード**: 既定保存は UTF-8。読み込みは「UTF-8（BOM 有無検出）としてまず読む → 不正バイト列を検出したら Shift_JIS で再試行」の 2 段フォールバック。手動指定の開き直しは `memo:readWithEncoding`。→ `fs/encoding.ts`。
- **改行コード**: CRLF/LF/CR を扱う。既定は「読み込み時検出した改行コードを維持して保存」。CodeMirror 6 は内部で `\n` へ正規化するため、**読み込み時の元 EOL 種別をメモのメタ情報として保持し、保存直前に LF テキストへ EOL 復元処理を挟む**（必須）。→ `fs/eol.ts` + レンダラ `editor/eolKeeper.ts`。

### 名前サニタイズ（PLAN §5.9 基礎）
[00-core-principles.md](../00-core-principles.md) §11 参照。M1 では入力/リネーム時の禁止文字・予約名・重複チェックの基礎を実装（UX の置換候補提示 UI は M2）。

## このフェーズで扱うディレクトリ/ファイル（PLAN §3）
- `src/main/fs/atomicWrite.ts` — temp書込→fsync→旧target→.bak→temp→target + 予約テーブル登録の一元化。ディレクトリ fsync は v1(NTFS 前提)では行わない（Fix6）
- `src/main/fs/tempNaming.ts` — 一時ファイルプレフィックス規則
- `src/main/fs/retry.ts` — Windows ロックエラー用リトライ
- `src/main/fs/pathSafety.ts` — サニタイズ・予約名・長パス検出・パス閉じ込め
- `src/main/fs/encoding.ts` — UTF-8/BOM 検出→Shift_JIS フォールバック
- `src/main/fs/eol.ts` — 改行コード検出・復元
- `src/main/fs/memoFileService.ts` — `.txt`/`.txtenc` の read/write/rename/move/duplicate（M1 は read/save/rename 中心）
- `src/main/fs/tabService.ts` — フォルダ=タブの登録・作成・走査（直下のみ, リンク無視）
- `src/main/fs/metaStore.ts` — タブ単位メタ JSON の読書き・復旧カスケード
- `src/main/util/result.ts`（M0 から）/ `src/main/util/hash.ts` — 実ファイル全体のバイト列ハッシュ（Fix4）
- `src/main/settings/appSettings.ts` — アプリ設定 JSON（アトミック保存・復旧）
- `src/main/ipc/tabHandlers.ts` / `memoHandlers.ts` / `settingsHandlers.ts`

## このフェーズのエラーハンドリング（[00-core-principles.md](../00-core-principles.md) §8）
関連行: 「Windows ロック（EBUSY/EPERM）」「メタ JSON 破損」「アプリ設定 JSON 破損」「名前重複/禁止文字」「保存中クラッシュ」「長パス」「予期せぬ例外」。Windows リトライは §7、hash 対象は §6 も参照。

## DESIGN.md の関連セクション
- データモデル/保存形式: DESIGN §3.1（メモ識別=ファイル名, サニタイズ）/ §3.2（メタの持ち方・堅牢性中核原則・同期順序・復旧カスケード）。
- 保存・アトミック書き込み・`.bak`: DESIGN §2.6。
- 文字コード/改行コード: DESIGN §2.3。
- タブ管理（重複禁止）: DESIGN §2.1。

## PLAN §8 整合メモの関連項目
- **メモ 6**（リネーム/移動/コピー/複製操作の外部変更競合は非検出＝受容済みリスク）: これらは内容変更を伴わないため `expectedHash` 競合検出を行わない。ごく稀にリネーム直前の外部変更で `evt:conflict` が発火しない場合があるがデータは失われない。v1 スコープでは追加の競合検出機構は実装しない。
