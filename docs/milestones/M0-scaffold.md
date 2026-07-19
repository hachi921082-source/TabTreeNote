# M0 — 足場（scaffold）

> 派生ドキュメント。正本は [PLAN.md](../../PLAN.md) / [DESIGN.md](../../DESIGN.md)。横断ルールは [00-core-principles.md](../00-core-principles.md)、型は [data-model.md](../data-model.md)。

## ゴール（PLAN §7 M0）
electron-vite プロジェクト初期化、TS strict、3 プロセス雛形、`contextIsolation`/`nodeIntegration`/`sandbox` 設定、`shared/ipc-contract.ts` と `Result` 型、**空の 3 ペイン UI + テーマ切替**（DESIGN §2.5）が動く状態。

## 依存関係
- 先行マイルストーン: なし（最初の土台）。M1 以降すべての基盤。

## 技術選定の確定/推奨（PLAN §0）
| 項目 | 採用 |
|------|------|
| アプリ形態 | Electron（メイン=Node.js / レンダラ=UI） |
| セキュリティ | `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` / preload 限定 IPC（preload は `contextBridge` と `ipcRenderer` のみ利用） |
| 言語 | TypeScript（`strict: true`） |
| UI フレームワーク | **React** |
| エディタ | **CodeMirror 6**（本格導入は M1 以降） |
| ツリー | 仮想化ライブラリ（例 `@tanstack/react-virtual`）+ 自前ツリー平坦化。DND は `dnd-kit` 等（本格導入は M2） |
| ファイル監視 | **chokidar**（導入は M4） |
| ビルド/バンドル | **electron-vite** + `electron-builder`（ポータブル配布） |
| 暗号 | Node 標準 `crypto`（導入は M6） |
| ごみ箱送り | Electron `shell.trashItem`（導入は M2） |
| 状態管理 | レンダラ: 軽量ストア（例 Zustand）。ファイル層の真実源はメイン側 |

## アーキテクチャ構成（PLAN §1）
3 レイヤ。**ファイル I/O・監視・永続化・暗号化・全文検索インデックスはすべてメインプロセス**に置く。レンダラは UI と UI 状態のみを持ち、ファイル/暗号操作は preload 経由の限定 IPC でメインへ委譲する（DESIGN §6）。
- **メインプロセス（Node 権限）**: ウィンドウ生成・ライフサイクル管理、タスクトレイ常駐（最小限、M7）。ファイル層/削除/監視/暗号/検索インデックス/セッション鍵ストア/外部起動を担う。
- **preload**: `contextBridge.exposeInMainWorld` で型付き API オブジェクト（例 `window.api`）を公開。公開するのは IPC チャネルをラップした関数群と通知購読関数のみ。`ipcRenderer` 生オブジェクトや `require`/Node API は一切露出しない。入力の一次サニタイズ（型チェック）を行う。
- **レンダラ（React, sandbox）**: 3 ペイン UI + ステータスバー、スプリッター、テーマ切替。UI 状態を保持し、永続すべきメタ/設定は IPC でメインに保存を依頼する。

## このフェーズで扱うディレクトリ/ファイル（PLAN §3）
electron-vite の標準レイアウトを立ち上げる。M0 で用意する骨格:
- ルート: `package.json` / `tsconfig.json` / `tsconfig.node.json` / `electron.vite.config.ts` / `electron-builder.yml`
- `src/main/index.ts` — app 起動・BrowserWindow 生成・トレイ・ライフサイクル（トレイは M7 で本格化）
- `src/main/ipc/registerIpc.ts` — 全 `ipcMain.handle` 登録の集約（空でよい。以降各 M でハンドラ追加）
- `src/main/util/result.ts` — `Result<T>` / エラーコード定義
- `src/preload/index.ts` — `contextBridge` で `window.api` を公開（型は shared から）
- `src/renderer/index.html` / `main.tsx` / `App.tsx`（3 ペインレイアウト・スプリッター）/ `theme/`（ライト/ダーク, CSS 変数）/ `ipc.ts`（`window.api` の薄いラッパ）
- `src/shared/ipc-contract.ts` — 全 IPC チャネル名・引数/返却型 / `models.ts` / `constants.ts`（拡張子・プレフィックス・スキーマ版・既定値）

（`src/main/fs/` `crypto/` `watch/` `search/` の各モジュールは M1 以降で追加。）

## このフェーズで扱う型/データ構造
- `Result<T>` / `ErrorCode` を [data-model.md](../data-model.md) §4 から `src/shared` + `src/main/util/result.ts` に定義。
- `shared/ipc-contract.ts` の骨格（チャネル名の名前空間だけでも先に定義しておくと以降の M が楽）。
- `constants.ts`: 拡張子 `.txt`/`.txtenc`、一時ファイルプレフィックス、`schemaVersion`、`.txtenc` の `magic`=`"TTNENC"` 等（[data-model.md](../data-model.md) §5）。

## このフェーズのセキュリティ（[00-core-principles.md](../00-core-principles.md) §10）
- `contextIsolation:true` / `nodeIntegration:false` / `sandbox:true` を **BrowserWindow 生成時に必ず設定**（セキュリティ不変条件）。
- preload は限定 API のみ公開。`ipcRenderer` 生オブジェクトや Node API を露出しない。

## このフェーズのエラーハンドリング
- IPC 境界での `Result` 化・`UNKNOWN` 丸めの土台を用意（[00-core-principles.md](../00-core-principles.md) §8 の表「予期せぬ例外」行）。実ハンドラは M1 以降。

## DESIGN.md の関連セクション（背景理由が必要な場合）
- 技術スタック確定の背景: DESIGN §0（Q1〜Q4）。
- 実装アーキテクチャ方針: DESIGN §6。
- テーマ（CSS ベース ライト/ダーク）: DESIGN §2.5。
- UI 3 ペイン構成: DESIGN §2.7。

## PLAN §8 整合メモの関連項目
- **メモ 5**（未確定だった実装時確定項目の既定化）: UI=React、エディタ=CodeMirror 6、ビルド=electron-vite+electron-builder を本 PLAN で確定既定とした（DESIGN が「実装時に確定」としていた範囲内）。
