# M7 — 仕上げ（polish）

> 派生ドキュメント。正本は [PLAN.md](../../PLAN.md) / [DESIGN.md](../../DESIGN.md)。横断ルールは [00-core-principles.md](../00-core-principles.md)、型は [data-model.md](../data-model.md)。

## ゴール（PLAN §7 M7）
ステータスバー、折り返し/タブ幅/行番号/可視化トグル、フォントサイズ、ショートカット、トレイ常駐（最小）、AutoReName（最初の非空行, 暗号化除外。最初の非空行が実際に変化した場合のみ + 編集停止から 500〜1000ms デバウンス後に発火。キー入力毎の即時リネームはしない）、設定画面、`schemaVersion`/`appVersion` マイグレーション土台、electron-builder ポータブル配布。

## 依存関係
- 先行: 実質的に M0〜M6 の機能が揃っていることが前提の総仕上げ。特に AutoReName は M1（`memo:rename`/同期順序）・M4（watcher/インデックス）・M6（暗号化メモ除外）に依存。

## このフェーズで扱う IPC チャネル（PLAN §2.6）
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `settings:get` / `settings:set` | – / `AppSettingsPatch` | `AppSettings` | アプリ設定 JSON の取得/部分更新（アトミック保存） |
| `app:getInfo` | – | `{ appVersion, schemaVersion }` | バージョン情報 |

（AutoReName は内部的に `memo:rename` 相当の処理を発火する。）

## このフェーズで扱う型/データ構造
- `AppSettings` 全体（`window`/`theme`/`editorDefaults`/`autosave`/`links`/`encoding`/`eol`/`shortcuts`/`sessionRememberPassword`）→ [data-model.md](../data-model.md) §2・§4。
- `AppSettingsPatch`（`DeepPartial<AppSettings>`）で部分更新（[data-model.md](../data-model.md) §4）。
- `schemaVersion` + `appVersion`（全 JSON に記録。マイグレーション土台, DESIGN §3.2）。

## このフェーズで扱う処理フロー

### AutoReName の発火制御（PLAN §5.9 / Fix12, DESIGN §2.2）
- 本文の最初の非空行を自動的にメモ名にする（「1 行目」ではなく**最初の非空行**を採用。空行始まりや Markdown でも自然に動く）。
- キー入力毎に即時リネームしない（リネーム→メタ保存→watcher→インデックス更新のカスケードが毎入力走ると負荷過大）。
- **(a) 最初の非空行の内容が実際に変化した場合のみ発火し、(b) 編集停止から 500〜1000ms 程度のデバウンスを挟んでから**リネーム処理（名前サニタイズ/重複回避を経て `memo:rename` 相当）を実行する。
- **暗号化メモ（`.txtenc`）は AutoReName 対象外**（最初の非空行取得に復号が必要で名前追従が破綻するため。手動リネームのみ, DESIGN §2.2/§2.9, M6）。

### 設定画面 / 各種エディタトグル（DESIGN §2.3 / §2.5 / §2.7）
- 折り返し切り替え（なし/文字数指定/ウィンドウ幅）、タブ幅・ソフトタブ・オートインデント、行番号表示、空白/改行可視化トグル、カーソル行ハイライト。
- 文字数/行数/カーソル位置をステータスバーに表示。フォント・文字サイズ変更（Ctrl+ホイール等）。
- ショートカット（既定は原作参考の妥当値。ユーザー設定可能な構造）。`AppSettings.shortcuts` に保存。
- テーマ（ライト/ダーク, CSS 変数）切替の仕上げ。

### トレイ常駐（最小限, DESIGN §2.7）
- タスクトレイ常駐 + ウィンドウ表示・非表示トグル程度。半透明・シェード・グローバルホットキー等は将来検討（v1 スコープ外）。

### マイグレーション土台（DESIGN §3.2）
- メタ JSON・アプリ設定 JSON に `schemaVersion` + `appVersion` を記録済み（M0/M1）。M7 では将来のマイグレーション要否判断ができる読み取り/変換の土台を用意（v1 は version=1 のみ）。

### 配布（DESIGN §6 / PLAN §0）
- electron-builder でポータブル配布（インストーラ不要）を優先。

## このフェーズで扱うディレクトリ/ファイル（PLAN §3）
- `src/main/settings/appSettings.ts`（設定の取得/部分更新の仕上げ）/ `src/main/ipc/settingsHandlers.ts`
- `src/main/index.ts`（トレイ常駐・表示トグル）
- レンダラ `src/renderer/components/StatusBar/`、`Editor/`（各種トグル・フォントサイズ）、`theme/`、設定画面 UI
- レンダラ `src/renderer/editor/eolKeeper.ts`（M1 と連携）、AutoReName ロジック（レンダラ側の変化検出+デバウンス → メイン `memo:rename`）
- ルート `electron-builder.yml`（ポータブル配布設定）

## このフェーズのエラーハンドリング（[00-core-principles.md](../00-core-principles.md) §8）
関連行: 「アプリ設定 JSON 破損」（アトミック保存+`.bak`+復旧、全滅時は既定設定で再生成し通知）、「名前重複/禁止文字」（AutoReName でも重複回避・サニタイズを経る）、「予期せぬ例外」。

## DESIGN.md の関連セクション
- テキスト編集（折り返し・タブ幅・行番号・可視化・フォント・ステータスバー・AutoReName=最初の非空行）: DESIGN §2.3 / §2.2。
- 外観・テーマ: DESIGN §2.5。ウィンドウ/操作・ショートカット・トレイ常駐: DESIGN §2.7。
- メタ/設定のバージョニング: DESIGN §3.2。配布・実装アーキテクチャ: DESIGN §6。

## PLAN §8 整合メモの関連項目
- **メモ 5**（未確定だった実装時確定項目の既定化: ビルド=electron-vite+electron-builder 等を確定既定とした）。
