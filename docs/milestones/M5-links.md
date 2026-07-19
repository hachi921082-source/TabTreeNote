# M5 — リンク機能

> 派生ドキュメント。正本は [PLAN.md](../../PLAN.md) / [DESIGN.md](../../DESIGN.md)。横断ルールは [00-core-principles.md](../00-core-principles.md)、型は [data-model.md](../data-model.md)。

## ゴール（PLAN §7 M5）
装飾（URL/mail/path/`memo:`）、外部起動（確認 + `path.resolve` + OS API）、`memo:` 解決・遷移（DESIGN §2.8）。

## 依存関係
- 先行: **M1/M2 後ならいつでも可**（PLAN §7 依存関係）。メモ/タブの解決には `tabService`/`metaStore`（M1）とツリー UI（M2）が前提。

## このフェーズで扱う IPC チャネル（PLAN §2.5）
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `link:openExternal` | `{ kind, raw, baseTabId? }` | `Result` | URL/mailto/ファイルパスの外部起動。相対パスは baseTab の絶対パス基準で `path.resolve`。確認ダイアログ要否は設定に従う |
| `link:resolveMemo` | `{ currentTabId, memoRef }` | `Result<{ tabId, memoName } \| null>` | `memo:` 記法の解決。解決不能時 null（エラー出さない） |

## このフェーズで扱う型/データ構造
- `link:openExternal` の `kind`（URL / mailto / ファイルパス等）と `raw`（元テキスト）、`baseTabId`（相対パス解決基準）。
- `AppSettings.links`（`openTrigger: 'ctrlClick' | 'singleClick' | 'doubleClick'` / `confirmBeforeOpen: boolean`）。既定は `ctrlClick` + 確認 ON（[data-model.md](../data-model.md) §2）。

## このフェーズで扱う処理フロー（PLAN §5.8）

### 装飾（レンダラ `editor/links.ts`）
本文から以下を検出し CodeMirror デコレーション付与:
- **URL**: `http://`, `https://`, `www.`, `ftp://` → 既定 Web ブラウザ。
- **メールアドレス**: `abc@example.com`（`mailto:` 前置も可）→ 既定メールソフト。
- **ファイルパス**: ドライブレター全般 `C:\...`, `.\`, `..\`, `file://` → 関連付けアプリ/フォルダ。相対パスはそのメモが属するタブ（管理フォルダ）基準で解決。
- **`memo:` 記法**: アプリ内リンク。

### 外部起動（DESIGN §2.8）
- クリック（既定 Ctrl+クリック, 設定可）→ 確認ダイアログ（既定 ON）→ `link:openExternal`。
- メインで相対パスを **`path.resolve(<管理フォルダ絶対パス>, rel)`** に変換してから `shell.openPath`（ファイル/フォルダ）／URL・mailto は `shell.openExternal`。
- **実装上の必須事項**: 相対パス文字列をそのまま `shell.openPath` に渡してはならない（OS はアプリ実行ファイルの場所からの相対と解釈するバグになる）。必ず絶対パスへ変換する。
- **シェル文字列連結は使わない**（OS コマンドインジェクション回避。セキュリティ不変条件, [00-core-principles.md](../00-core-principles.md) §10）。

### `memo:` 解決（`link:resolveMemo`, DESIGN §2.8）
メイン側で以下を解決:
- `memo:メモ名` … 現在タブ内の該当メモ。
- `memo:タブ名/メモ名`（区切りは `/` または `\`）… 指定タブの指定メモ。
- `memo:タブ名/` … 指定タブを開く。
- **名前解決対象は `.txt` と `.txtenc` 両方**（拡張子除去名で照合）。タブ名重複禁止・同名メモ非共存により常に一意に解決できる。
- 解決先が `.txtenc` なら開封フロー（M6 / §5.5）へ。**解決不能は null（エラーダイアログは出さない）**。
- 番号/位置系記法（`#3`, `[ABC]`, `[#10,#5]` 等）は **v1 任意**（実装余力次第で段階導入）。最低限メモ名/タブ名指定でのジャンプを確実に実装する。

### 安全性（DESIGN §2.8）
- ファイルパス/URL を外部アプリで開く前に確認ダイアログを出すオプション（既定 ON 推奨）。特に実行ファイル（.exe/.bat）や `file://`・ローカルパスの起動は OS 標準オープン API を使いパスを引数として安全に渡す。`memo:` は外部起動を伴わないアプリ内遷移のみ。

## このフェーズで扱うディレクトリ/ファイル（PLAN §3）
- `src/main/ipc/linkHandlers.ts`
- レンダラ `src/renderer/editor/links.ts` — URL/mail/path/`memo:` のパターン検出とデコレーション
- 外部起動確認ダイアログ（`components/dialogs/`）

## このフェーズのエラーハンドリング（[00-core-principles.md](../00-core-principles.md) §8）
- `memo:` 解決不能は **エラーにせず null**（DESIGN §2.8）。外部起動失敗は `Result` エラーとして扱う。IPC 境界での `Result`/`UNKNOWN` 丸めは共通どおり。

## DESIGN.md の関連セクション
- リンク機能（自動リンク認識・`memo:` 記法・操作方法・安全性・相対パス解決の必須事項）: DESIGN §2.8。
- セキュリティ（外部起動は OS 標準 API・シェル連結回避）: DESIGN §6 / §2.8。

## PLAN §8 整合メモの関連項目
- **メモ 5**（リンク操作の既定=Ctrl+クリック+確認 ON を本 PLAN で確定既定とした。DESIGN が「実装時に確定」「既定 ON 推奨」としていた範囲内）。
