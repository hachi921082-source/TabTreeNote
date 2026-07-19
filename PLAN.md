# TabTreeNote 実装計画 (PLAN.md)

> 本ドキュメントは、確定済みの [DESIGN.md](DESIGN.md) を土台に、developer がそのまま実装に着手できる粒度へ落とし込んだ**実装計画**である。
> DESIGN.md に記載された確定済みの設計判断・トレードオフを変更・再解釈するものではない。両者に齟齬が生じた場合、設計判断の正本は DESIGN.md、実装計画の初版は本 PLAN.md とする。
> 本 PLAN.md 作成後は本ファイルを原則上書きせず、追加の設計変更は DESIGN.md 側で扱う運用に切り替える（CLAUDE.md ワークフロー準拠）。
>
> 対象 OS: Windows 11 優先（§DESIGN §3・§4）。技術スタック: Electron + TypeScript（§DESIGN §0 Q1・§6）。
> **変数名・内部関数分割などの実装細部は developer 判断に委ねる**（DESIGN §6 末尾）。本計画は責務分担・データ構造・処理フロー・順序制約・エラー方針を規定する。

---

## 0. 前提と技術選定の確定/推奨

DESIGN.md で「確定」のものはそのまま採用。「実装時に確定」とされていた項目は本 PLAN で以下の既定を推奨する（developer は妥当な理由があれば変更してよいが、変更時は DESIGN.md 側の該当箇所と矛盾しないこと）。

| 項目 | DESIGN.md での状態 | 本 PLAN の採用/推奨 |
|------|--------------------|---------------------|
| アプリ形態 | Electron + Node.js メイン / レンダラ UI（確定） | 採用 |
| セキュリティ | `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` / preload 限定 IPC（確定） | 採用。`sandbox: true` を推奨（preload では `contextBridge` と `ipcRenderer` のみ利用） |
| 言語 | TypeScript（確定） | 採用。`strict: true` |
| UI フレームワーク | React または軽量代替（実装時確定） | **React** を採用（DESIGN §2.5/§6 の想定に沿う） |
| エディタ | CodeMirror 6 第一候補（実装時確定） | **CodeMirror 6** を採用 |
| ツリー | 仮想スクロール対応（確定） | 仮想化ライブラリ（例: `@tanstack/react-virtual`）+ 自前ツリー平坦化。DND は `dnd-kit` 等を推奨 |
| ファイル監視 | chokidar（確定） | **chokidar** を採用 |
| ビルド/バンドル | 明記なし | **electron-vite**（Vite ベース、メイン/preload/レンダラを一括） + `electron-builder`（ポータブル配布, §6） |
| 暗号 | Node 標準 `crypto`（scrypt/AES-256-GCM）（確定） | 採用。追加依存なし |
| ごみ箱送り | OS ごみ箱（確定） | Electron `shell.trashItem`（メイン側） |
| 状態管理 | 一元ストア（確定） | レンダラ: 軽量ストア（例 Zustand）。ファイル層の真実源はメイン側 |

---

## 1. アーキテクチャ構成（責務分担）

3 レイヤ（メインプロセス / preload / レンダラ）。**ファイル I/O・監視・永続化・暗号化・全文検索インデックスはすべてメインプロセス**に置く。レンダラは UI と UI 状態のみを持ち、ファイル/暗号操作は preload 経由の限定 IPC でメインへ委譲する（DESIGN §6）。

### 1.1 メインプロセス（Node.js 権限）
責務:
- ウィンドウ生成・ライフサイクル管理、タスクトレイ常駐（最小限、§2.7）。
- **ファイル層**: タブ（フォルダ）/メモ（`.txt`/`.txtenc`）/メタ JSON/アプリ設定 JSON の読み書き。アトミック書き込み（temp→rename）+ 直近 1 世代 `.bak`（§2.6）。
- **削除**: `shell.trashItem` によるごみ箱送り、失敗時フォールバック（§2.6）。暗号化変換時の平文原本のみ直接 `fs.unlink`（§2.9）。
- **ファイル監視**: chokidar による外部変更検知。一時ファイルプレフィックスの `ignored` 除外、自己書き込み予約テーブルによる自己発火除外、デバウンス、競合判定（mtime+サイズ+ハッシュ）（§3.3）。
- **暗号化/復号**: `crypto.scrypt` + AES-256-GCM。鍵・パスワード・復号平文はメインにのみ保持し**レンダラへ渡さない**（§2.9・§6）。ただしエディタ表示のため復号平文本文はレンダラへ送る必要がある → 後述 §1.4 の注記を参照。
- **全文検索インデックス**: メモリ内軽量インデックス。起動時構築・差分更新 2 経路（§2.4）。
- **セッション鍵ストア**: 開封済み暗号化メモの導出鍵をメインのメモリ上にのみ保持（セッション内、永続化しない、§2.9）。**ストアのキーは `(tabId, memoName)` の組（またはメモの絶対パス）とし、`memoName` 単体をキーにしない**（タブ名は重複禁止だが同名メモは異なるタブに共存しうるため。§2.1・§1.4・§5.5）。
- **外部起動**: `shell.openPath`（ファイル/フォルダ）/ `shell.openExternal`（URL/mailto）。相対パスは管理フォルダ基準で `path.resolve` 済みの絶対パスに変換してから渡す（§2.8）。

### 1.2 preload
- `contextBridge.exposeInMainWorld` で型付き API オブジェクト（例 `window.api`）を公開。
- 公開するのは §2 の IPC チャネルをラップした関数群と、メイン→レンダラ通知の購読関数のみ。`ipcRenderer` 生オブジェクトや `require`/Node API は一切露出しない。
- 入力の一次サニタイズ（型チェック）を行い、メインへ渡す。

### 1.3 レンダラ（React, sandbox）
責務:
- 3 ペイン UI（タブバー / ツリー(左) / エディタ(右)）+ ステータスバー、スプリッター、テーマ切替（§2.5/§2.7）。
- CodeMirror 6 によるエディタ、検索・置換 UI、ツリーの仮想化描画・DND。
- UI 状態（選択メモ、展開状態の一時反映、ダイアログ、テーマ適用）を保持。**永続すべきメタ/設定は IPC でメインに保存を依頼**（真実源はメイン側ファイル層）。
- リンク装飾（CodeMirror デコレーション）とクリックハンドリング（外部起動/`memo:` 遷移は IPC 経由）。

### 1.4 復号平文の取り扱いに関する実装注記（重要・DESIGN §2.9 準拠）
- DESIGN §2.9 は「鍵・パスワードはレンダラへ渡さない」「復号平文はディスクへ書き出さない・メモリ最小露出」を要求する。**鍵とパスワードはメインに閉じる**。
- 一方でエディタ表示・編集のため、**復号された本文テキスト自体はレンダラ（CodeMirror）へ渡さざるを得ない**。これは DESIGN の「復号平文はメモリ上のみに保持し一時ファイル等ディスクへ書き出さない」に反しない（レンダラもメモリ上であり、ディスク書き出しはしない）。DESIGN が禁じているのは (a) 鍵/パスワードのレンダラ露出、(b) 平文のディスク永続化、(c) 平文の全文検索インデックスへの取り込み（§2.4）であり、エディタへの平文供給自体は許容範囲。
- したがって暗号化メモの編集フローは「開封時: メインで復号 → 平文本文のみレンダラへ IPC 送信」「保存時: レンダラの平文本文をメインへ送信 → メインがセッション鍵で新 IV 再暗号化して `.txtenc` へ書き戻し」とする。導出鍵はメインのセッション鍵ストアに保持し、レンダラへは渡さない。**セッション鍵ストアのキーは `(tabId, memoName)` の組（またはメモの絶対パス）とする。`memoName` 単体をキーにしてはならない**——タブ名は重複禁止だが、異なるタブに同名メモ（例: 複数タブの `README`）が共存しうるため（§2.1）、`memoName` 単体だと別タブの同名暗号化メモ間で鍵が衝突する実バグになる。
- 平文残留防止: メモ切替/ロック/終了時にレンダラ側の当該 CodeMirror ドキュメントと Undo 履歴を破棄（§2.9 の厳格破棄）。メイン側もセッション鍵の失効/破棄を行う。

---

## 2. IPC チャネル設計

方式: すべて `ipcMain.handle` / `ipcRenderer.invoke`（リクエスト/レスポンス）を基本とし、メイン→レンダラの一方向イベント（監視通知・競合通知・インデックス更新通知等）は `webContents.send` + preload 購読関数で扱う。チャネル名は名前空間付き（例 `tab:list`, `memo:read`）。返却は `Result<T>` 型（成功/失敗を判別可能な discriminated union、§5 参照）で統一し、例外はメイン境界で捕捉してエラーコード化する。

### 2.1 タブ（管理フォルダ）操作
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `tab:list` | – | `TabInfo[]` | 登録タブ一覧（アプリ設定の登録順） |
| `tab:register` | `{ folderPath }` | `TabInfo` | 既存フォルダをタブ登録。表示名重複チェック（§2.1） |
| `tab:create` | `{ parentDir, name }` | `TabInfo` | 新規フォルダ作成+タブ登録。名前サニタイズ+重複拒否 |
| `tab:rename` | `{ tabId, newName }` | `Result` | フォルダリネーム。重複拒否・サニタイズ・同期順序（§3.3） |
| `tab:remove` | `{ tabId, deleteFolder? }` | `Result` | タブ登録解除（既定はフォルダ削除しない）。削除指定時はごみ箱送り |
| `tab:reorder` | `{ orderedTabIds }` | `Result` | タブ並べ替え。`orderedTabIds` の順に `AppSettings.tabs` **配列自体を並べ替えて**アトミック保存する（配列順が並び順の唯一の正本。`order` フィールドは持たない, §4.2/Fix7） |
| `tab:openTree` | `{ tabId }` | `TreeSnapshot` | タブのツリー（メタ+実ファイル突合結果）を取得 |

### 2.2 メモ操作
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `memo:read` | `{ tabId, memoName }` | `MemoReadResult` | 平文 `.txt` 読込。本文+検出エンコーディング+検出改行コード（§2.3）。`.txtenc` はここでは本文を返さず暗号化フラグのみ |
| `memo:readWithEncoding` | `{ tabId, memoName, encoding }` | `MemoReadResult` | エンコーディング明示指定で開き直す（§2.3） |
| `memo:save` | `{ tabId, memoName, contentLF, eol, encoding, expectedHash? }` | `SaveResult` | 平文保存。改行コード復元→エンコード→アトミック書込+`.bak`。`expectedHash` で外部変更競合検出（§3.3） |
| `memo:create` | `{ tabId, name, position, anchorMemoName? }` | `MemoInfo` | メモ新規作成（追加位置: before/after/child/first/last、§2.2） |
| `memo:rename` | `{ tabId, oldName, newName }` | `Result` | メモ+ファイルのリネーム。同期順序（§3.3） |
| `memo:delete` | `{ tabId, memoNames[], forceDirect? }` | `Result` | 既定（`forceDirect` 無/false）はごみ箱送り。失敗時は `evt:trashFallback` 通知 → UI 確認 → **ユーザー承諾後に `forceDirect:true` で再 invoke** し直接 `fs.unlink`（§2.6。無確認直接削除はしない） |
| `memo:duplicate` | `{ tabId, memoName }` | `MemoInfo` | 複製 |
| `memo:move` | `{ srcTabId, memoNames[], destTabId, destPosition, copy }` | `Result` | タブ間/タブ内移動・コピー（Ctrl でコピー、§2.2） |
| `tree:updateStructure` | `{ tabId, treeStructure }` | `Result` | ツリー順序・階層・開閉・ラベルのメタ更新（アトミック保存） |

### 2.3 検索
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `search:global` | `{ scope, query, options }` | `SearchHit[]` | 全文検索（メモリ内インデックス）。scope=all/currentTab。暗号化メモは名前のみ対象（§2.4） |
| `search:history:get` / `search:history:add` | – / `{ query }` | – | 検索履歴 |

（現在メモ内の検索・置換・正規表現・インクリメンタルはレンダラの CodeMirror 内で完結し IPC 不要。§2.4）

### 2.4 暗号化
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `crypto:encryptMemo` | `{ tabId, memoName, password, hint? }` | `Result<MemoInfo>` | 平文 `.txt`→`.txtenc` 変換（§2.9 変換フロー）。平文原本は直接削除 |
| `crypto:decryptMemoToPlain` | `{ tabId, memoName, password }` | `Result<MemoInfo>` | 明示的な暗号化解除。`.txtenc`→`.txt`（平文は通常扱い） |
| `crypto:open` | `{ tabId, memoName, password }` | `Result<{ contentLF, eol, hash }>` | 開封（復号）。成功時セッション鍵をメイン保持（キー `(tabId, memoName)`, §1.4）、本文平文をレンダラへ。`hash` は `.txtenc` **ファイル全体のバイト列**のハッシュ（次回保存競合判定用, §3.3/Fix4） |
| `crypto:saveEncrypted` | `{ tabId, memoName, contentLF, eol, expectedHash? }` | `SaveResult` | 開封中メモの保存。**`expectedHash` で外部変更競合検出**（平文 `memo:save` と対称, §3.3）→ セッション鍵で**新 IV** 再暗号化して書戻し（§2.9） |
| `crypto:changePassword` | `{ tabId, memoName, oldPassword, newPassword }` | `Result` | 新 salt+新 IV で再暗号化（§2.9） |
| `crypto:lock` | `{ tabId, memoName }` | `Result` | セッション鍵破棄（再ロック）。レンダラは平文/履歴を破棄 |

### 2.5 リンク/外部起動
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `link:openExternal` | `{ kind, raw, baseTabId? }` | `Result` | URL/mailto/ファイルパスの外部起動。相対パスは baseTab の絶対パス基準で `path.resolve`（§2.8）。確認ダイアログ要否は設定に従う |
| `link:resolveMemo` | `{ currentTabId, memoRef }` | `Result<{ tabId, memoName } \| null>` | `memo:` 記法の解決（§2.8）。解決不能時 null（エラー出さない） |

### 2.6 設定・アプリ
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `settings:get` / `settings:set` | – / `AppSettingsPatch` | `AppSettings` | アプリ設定 JSON の取得/部分更新（アトミック保存） |
| `app:getInfo` | – | `{ appVersion, schemaVersion }` | バージョン情報 |

### 2.7 メイン→レンダラ通知（`webContents.send`）
| イベント | ペイロード | 説明 |
|----------|-----------|------|
| `evt:externalChange` | `{ tabId, changes }` | 外部変更を検知しツリー/本文に反映が必要（§3.3） |
| `evt:conflict` | `{ tabId, memoName }` | 編集中メモに外部変更（競合ダイアログを開く。§3.3 解決中ロック） |
| `evt:indexUpdated` | `{ tabId? }` | 検索インデックス更新（UI 側の再検索が必要な場合） |
| `evt:metaRecovered` | `{ tabId, mode }` | メタ破損復旧カスケード発動の通知（§3.2） |
| `evt:trashFallback` | `{ tabId, memoNames, reason }` | ごみ箱送り失敗。UI で直接削除確認を出し、承諾されたら `memo:delete` を `forceDirect:true` で再 invoke する（§2.6） |
| `evt:opError` | `{ code, message, path? }` | リトライ後も失敗した I/O エラー等 |

---

## 3. ディレクトリ・ファイル構成

electron-vite の標準レイアウトに沿う。`src/` 配下をプロセス別に分割。

```
TabTreeNote/
├─ package.json
├─ tsconfig.json / tsconfig.node.json
├─ electron.vite.config.ts
├─ electron-builder.yml            # ポータブル配布設定（§6）
├─ src/
│  ├─ main/                        # メインプロセス（Node 権限）
│  │  ├─ index.ts                  # app 起動・BrowserWindow 生成・トレイ・ライフサイクル
│  │  ├─ ipc/
│  │  │  ├─ registerIpc.ts         # 全 ipcMain.handle 登録の集約
│  │  │  ├─ tabHandlers.ts
│  │  │  ├─ memoHandlers.ts
│  │  │  ├─ cryptoHandlers.ts
│  │  │  ├─ searchHandlers.ts
│  │  │  ├─ linkHandlers.ts
│  │  │  └─ settingsHandlers.ts
│  │  ├─ fs/                       # ファイル層
│  │  │  ├─ atomicWrite.ts         # temp書込→fsync→旧target→.bak→temp→target（§5.2順序）+ 予約テーブル登録の一元化（§3.3）。ディレクトリ自体のfsyncはv1(NTFS前提)では行わない（§5.2/Fix6）
│  │  │  ├─ tempNaming.ts          # 一時ファイルプレフィックス規則（§3.3）
│  │  │  ├─ retry.ts               # Windows ロックエラー用リトライ（§3.3）
│  │  │  ├─ trash.ts               # shell.trashItem + フォールバック（§2.6）
│  │  │  ├─ pathSafety.ts          # サニタイズ・予約名・長パス検出・パス閉じ込め
│  │  │  ├─ encoding.ts            # UTF-8/BOM 検出→Shift_JIS フォールバック（§2.3）
│  │  │  ├─ eol.ts                 # 改行コード検出・復元（§2.3）
│  │  │  ├─ memoFileService.ts     # .txt/.txtenc の read/write/rename/move/duplicate
│  │  │  ├─ tabService.ts          # フォルダ=タブの登録・作成・走査（直下のみ, リンク無視）
│  │  │  └─ metaStore.ts           # タブ単位メタ JSON の読書き・復旧カスケード（§3.2）
│  │  ├─ crypto/
│  │  │  ├─ cipher.ts              # scrypt(非同期 crypto.scrypt) + AES-256-GCM、.txtenc シリアライズ/パース（§2.9・§4.3）
│  │  │  ├─ encFormat.ts           # .txtenc バイナリ/JSON フォーマット定義とバージョニング
│  │  │  └─ sessionKeyStore.ts     # 開封中メモの導出鍵をメモリ保持（永続化しない）。キーは (tabId, memoName) の組（またはメモ絶対パス）。memoName 単体をキーにしない（§2.1 参照）
│  │  ├─ watch/
│  │  │  ├─ watcher.ts             # chokidar 起動・ignored・デバウンス。ignored には一時ファイルプレフィックスに加え Windows の OS 生成ファイル（desktop.ini / Thumbs.db 等）も含める（Fix10）
│  │  │  ├─ selfWriteRegistry.ts   # 自己書き込み予約テーブル（§3.3 包括原則）。イベント消費で即時クリア + TTL(既定2–3秒)自動失効のハイブリッド（§5.6）
│  │  │  └─ conflict.ts            # mtime+サイズ+ハッシュ competition 判定（§3.3）
│  │  ├─ search/
│  │  │  └─ searchIndex.ts         # メモリ内軽量インデックス（構築・2 経路差分更新, §2.4）
│  │  ├─ settings/
│  │  │  └─ appSettings.ts         # アプリ設定 JSON（アトミック保存・復旧）
│  │  └─ util/
│  │     ├─ result.ts              # Result<T> / エラーコード定義
│  │     └─ hash.ts                # コンテンツハッシュ。対象は常に「ディスク上の実ファイル全体のバイト列」（平文本文や暗号文部分のみではない, Fix4）。.txtenc はヘッダ(hint 等)込みのファイル全体を対象とし、hint 変更も競合検出できる
│  ├─ preload/
│  │  └─ index.ts                  # contextBridge で window.api を公開（型は shared から）
│  ├─ renderer/                    # レンダラ（React, sandbox）
│  │  ├─ index.html
│  │  ├─ main.tsx
│  │  ├─ App.tsx                   # 3 ペインレイアウト・スプリッター
│  │  ├─ store/                    # UI 状態（Zustand 等）
│  │  ├─ components/
│  │  │  ├─ TabBar/
│  │  │  ├─ Tree/                  # 仮想化ツリー・DND・開閉・複数選択
│  │  │  ├─ Editor/                # CodeMirror 6 ラッパ・リンク装飾・改行コード保持
│  │  │  ├─ StatusBar/
│  │  │  ├─ Search/                # 現在メモ内検索・置換 UI、全文検索パネル
│  │  │  └─ dialogs/               # パスワード入力・競合解決・削除確認・サニタイズ提案
│  │  ├─ editor/
│  │  │  ├─ links.ts               # URL/mail/path/memo: のパターン検出とデコレーション（§2.8）
│  │  │  └─ eolKeeper.ts           # メタ改行コード種別の保持と CM6 連携（§2.3）
│  │  ├─ theme/                    # ライト/ダーク（CSS 変数, §2.5）
│  │  └─ ipc.ts                    # window.api 呼び出しの薄いラッパ
│  └─ shared/                      # メイン/preload/レンダラ共通の型定義
│     ├─ ipc-contract.ts           # 全 IPC チャネル名・引数/返却型（§2）
│     ├─ models.ts                 # TabInfo/MemoInfo/MetaTreeNode(永続化用)/TreeNode(実行時用)/AppSettings/TabMeta 等（§4）
│     └─ constants.ts              # 拡張子・プレフィックス・スキーマ版・既定値
└─ （DESIGN.md / spec.md / CatMemoNote/ など既存）
```

---

## 4. 主要データ構造 / 型

TypeScript 型として `src/shared/models.ts` に定義。スキーマは JSON。`schemaVersion` + `appVersion` を全 JSON に記録（§3.2）。

### 4.1 タブ単位メタ JSON（`.tabtreenote.json`、フォルダ内隠しメタ）
DESIGN §3.2 の既定案（フォルダ内メタファイル）を採用。ツリー構造・順序・開閉・ラベル・メモ毎エディタ設定を保持。

```jsonc
{
  "schemaVersion": 1,
  "appVersion": "0.1.0",
  "tree": [                         // ルート直下ノードの配列（順序=表示順）
    {
      "memoName": "買い物メモ",       // 拡張子を除いたファイル名（.txt/.txtenc 共通空間, §3.1）
      "expanded": true,
      "label": { "color": "blue", "kind": null },   // 簡易な色/種別ラベル（§2.2, 優先度中）
      "editor": { "wrap": "window", "font": null },  // メモ毎エディタ設定（任意, §3.2）
      "children": [ /* 同構造の MetaTreeNode 再帰。encrypted は保存しない（§4.4 型分離参照） */ ]
    }
  ]
}
```

- メタは「ファイル名参照 + ツリー構造」のみを持ち、暗号化状態のフラグは持たない（暗号化かどうかは実ファイルの拡張子 `.txtenc` が真実源。DESIGN §2.9 も「真実源は拡張子 `.txtenc`、メタJSONには暗号フラグを冗長に持たせない」と規定しており本設計と整合。→ §8 の整合メモ参照）。
- 「パスワードヒント」を保存する場合は該当 `.txtenc` ファイル内（平文フィールド）に格納する（§2.9。ヒントは平文保存の旨を UI 警告）。メタ JSON には保存しない。
- **型の分離（§4.4 参照）**: メタ JSON に永続化されるツリー要素は **`MetaTreeNode`**（`memoName`/`expanded`/`label`/`editor`/`children` のみ、`encrypted` を**持たない**）である。`tab:openTree` がレンダラへ返す実行時ツリーは **`TreeNode`**（`MetaTreeNode` の内容に、走査時に拡張子から導出した `encrypted` を付与したもの）。**メタ JSON へ書き出すのは常に `MetaTreeNode`** であり、`encrypted` 付き `TreeNode` をそのままシリアライズしてはならない（暗号化状態の真実源は拡張子 `.txtenc`、§8-1）。
- **突合ロジック**: タブを開くとき `metaStore` が (a) メタ JSON の tree（`MetaTreeNode[]`）と (b) フォルダ直下実ファイル走査結果（`.txt`/`.txtenc`、直下のみ、シンボリックリンク/ジャンクション無視, §2.2）を突合し、**実行時用の `TreeNode[]`（各ノードに拡張子由来の `encrypted` を付与）を構築して返す**。メタにあり実体が無いノードは除外、実体にありメタに無いファイルはツリー末尾へフラット追加。逆にメタを保存する際は `encrypted` を落として `MetaTreeNode[]` に変換してから永続化する。

### 4.2 アプリ設定 JSON（ユーザー設定ディレクトリ or アプリ配置フォルダ、§3.4）
```jsonc
{
  "schemaVersion": 1,
  "appVersion": "0.1.0",
  "tabs": [ { "id": "t1", "name": "仕事", "folderPath": "C:\\notes\\work" } ],
  // ↑ タブの並び順は「この配列の順序」を唯一の正本とする（order フィールドは持たない。Fix7）。
  //   tab:reorder は受け取った orderedTabIds の順にこの配列を並べ替えて保存する。
  "window": { "x": 100, "y": 100, "width": 1200, "height": 800, "maximized": false, "treeWidth": 260, "treeSide": "left" },
  "theme": "dark",                  // "light" | "dark"
  "editorDefaults": { "wrap": "window", "tabWidth": 4, "softTab": true, "showLineNumbers": true, "fontSize": 14 },
  "autosave": { "plainDebounceMs": 1500, "encryptedDebounceMs": 5000 },  // 暗号化メモは低頻度（§2.6）
  "links": { "openTrigger": "ctrlClick", "confirmBeforeOpen": true },     // 既定: 修飾キー併用+確認ON（§2.8）
  "encoding": { "defaultSave": "utf-8" },
  "eol": { "policy": "preserve" },  // "preserve" | "crlf" | "lf" | "cr"（§2.3）
  "shortcuts": { /* action -> key。既定は原作参考の妥当値（§2.7） */ },
  "sessionRememberPassword": true   // セッション内メモリ保持（永続保存しない, §2.9）
}
```

### 4.3 暗号化ファイル `.txtenc` フォーマット（§2.9）
自己記述的なコンテナ。JSON ヘッダ + Base64 本文（実装は JSON でよい。バイナリ最適化は将来）。

```jsonc
{
  "magic": "TTNENC",
  "formatVersion": 1,
  "kdf": { "algo": "scrypt", "N": 32768, "r": 8, "p": 1, "keyLen": 32, "saltB64": "..." },
  "cipher": { "algo": "aes-256-gcm", "ivB64": "...(12B, 毎回新規)", "tagB64": "...(認証タグ)" },
  "eol": "crlf",                    // 復号後に復元する改行コード種別（§2.3）
  "hint": "…任意。平文保存の旨UI警告…",  // 省略可
  "ciphertextB64": "…暗号文…"
}
```
- scrypt コストパラメータ（N/r/p/keyLen）は**ファイルに記録**し、復号時はファイル内の値を使う（将来のパラメータ引き上げに耐える）。初回/パスワード変更時は本 PLAN 既定 **N=32768（2^15）/r=8/p=1/keyLen=32（メモリ約 32MB 目安）** で生成。2026 年基準でより高強度側に寄せた値。developer は実機で体感遅延と強度のバランスを見て確定してよい（記録方式のため後日の引き上げも可能）。なお `crypto.scryptSync` の既定 `maxmem`（32MB）は N=32768/r=8 で不足し得るため、鍵導出時は `maxmem` を明示的に十分な値（例 64MB）へ引き上げること。
- **鍵導出は必ず非同期版 `crypto.scrypt`（コールバック API）を使う**。`crypto.scryptSync` は使用しない。scrypt は意図的に計算負荷が高い KDF であり、同期版をメインプロセス（Electron メインは単一イベントループ）で回すと鍵導出中（数百ミリ秒〜）UI 描画・他 IPC 応答・トレイ反応まで全てフリーズするため。実装では `util.promisify(crypto.scrypt)` するか Promise ラッパーを自前実装し、`await` で導出する。非同期 `crypto.scrypt` の第 4 引数 `options` で `maxmem` を明示的に十分な値（例 64MB）へ引き上げる（N=32768/r=8 では既定の `maxmem`（32MB）が不足し得るため）。`N`/`r`/`p`/`keyLen` は `options` および引数で指定する。
- salt はパスワード維持中は不変、パスワード変更時のみ再生成。**IV は書き込み毎に必ず新規**（§2.9 IV 再利用禁止）。
- `.bak` の中身も同フォーマットの暗号化済みデータ（平文は残さない, §2.6）。

### 4.4 IPC 共通型（`src/shared`）
```ts
type Result<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; path?: string } };

type ErrorCode =
  | 'NAME_DUPLICATE' | 'NAME_INVALID' | 'NOT_FOUND' | 'IO_LOCKED'
  | 'TRASH_FAILED' | 'DECRYPT_FAILED' | 'CONFLICT' | 'META_CORRUPT'
  | 'LONG_PATH' | 'UNKNOWN';

// hash 系フィールドはすべて「ディスク上の実ファイルの内容そのもの（ファイル全体のバイト列）のハッシュ」（Fix4）。
// 平文本文のハッシュや、.txtenc の暗号文(ciphertext)部分のみのハッシュではない。
// → .txtenc の場合は JSON ヘッダ（hint 等）を含むファイル全体が対象なので、hint 変更のようなヘッダ部分の変更も競合として検出できる。
interface MemoReadResult { contentLF: string; encoding: 'utf-8'|'utf-8-bom'|'shift_jis'; eol: Eol; encrypted: boolean; hash: string; /* 実ファイル全体のバイト列ハッシュ */ }
type Eol = 'crlf' | 'lf' | 'cr';
interface SaveResult { savedHash: string; }   // 保存後の実ファイル全体（バイト列）のハッシュ（次回競合判定用, Fix4）
interface TabInfo { id: string; name: string; folderPath: string; }

// ラベル（§2.2 簡易な色/種別ラベル。§4.1 メタJSON例に対応）
interface Label { color: string | null; kind: string | null; }

// メモ毎エディタ設定（§3.2 任意。null は「アプリ既定に従う」）
interface MemoEditorSettings { wrap?: 'none' | 'chars' | 'window'; font?: string | null; }

// 【永続化専用】ツリーノード（メタJSON `.tabtreenote.json` の tree に実際にシリアライズされる要素。再帰構造。§4.1）
// encrypted を持たない: 暗号化状態の真実源は実ファイル拡張子 .txtenc であり、メタJSONには保存しない（§4.1/§8-1）。
// TabMeta.tree の要素はこの型。メタJSONに書き出されるのは常に MetaTreeNode であり、TreeNode（encrypted 付き）ではない。
interface MetaTreeNode {
  memoName: string;              // 拡張子を除いたファイル名（.txt/.txtenc 共通空間, §3.1）
  expanded: boolean;
  label?: Label;
  editor?: MemoEditorSettings;
  children: MetaTreeNode[];
}

// 【実行時/UI 専用】ツリーノード（tab:openTree のメタ+実ファイル突合結果として構築, §4.1 突合ロジック）。
// MetaTreeNode の内容に、フォルダ走査時に拡張子(.txtenc)から導出した encrypted を付与したもの。
// この型はメタJSONへシリアライズしない（永続化には必ず MetaTreeNode を使う）。読み取り専用スナップショット（TreeSnapshot 参照, Fix5）。
interface TreeNode {
  readonly memoName: string;     // 拡張子を除いたファイル名（.txt/.txtenc 共通空間, §3.1）
  readonly encrypted: boolean;   // 実ファイル拡張子(.txtenc)から走査時に導出（メタには保存しない, §4.1）
  readonly expanded: boolean;
  readonly label?: Label;
  readonly editor?: MemoEditorSettings;
  readonly children: readonly TreeNode[];
}

// タブ単位メタJSON（`.tabtreenote.json` 全体, §4.1）。永続化用のため tree は MetaTreeNode[]（encrypted を含まない）。
interface TabMeta { schemaVersion: number; appVersion: string; tree: MetaTreeNode[]; }

// メモ1件の情報（memo:create / memo:duplicate / crypto:encryptMemo 等の返却, §2.2）
interface MemoInfo { memoName: string; encrypted: boolean; }

// タブを開いた際のツリースナップショット（メタ+実ファイル突合結果, tab:openTree の返却, §4.1 突合ロジック）
// 実行時/UI 用の TreeNode[]（encrypted 付き）を返す。永続化用の MetaTreeNode ではない点に注意。
// 「スナップショット」の設計意図（読み取り専用データ）を型で表現するため readonly を付与（Fix5。IPC でコピーされるため実害はないが不変性を明示）。
interface TreeSnapshot { readonly tabId: string; readonly tree: readonly TreeNode[]; }

// アプリ設定JSON（§4.2 の構造に対応）
interface AppSettings {
  schemaVersion: number;
  appVersion: string;
  tabs: { id: string; name: string; folderPath: string }[];  // 並び順は配列順が正本。order フィールドは持たない（Fix7）
  window: { x: number; y: number; width: number; height: number; maximized: boolean; treeWidth: number; treeSide: 'left' | 'right' };
  theme: 'light' | 'dark';
  editorDefaults: { wrap: 'none' | 'chars' | 'window'; tabWidth: number; softTab: boolean; showLineNumbers: boolean; fontSize: number };
  autosave: { plainDebounceMs: number; encryptedDebounceMs: number };
  links: { openTrigger: 'ctrlClick' | 'singleClick' | 'doubleClick'; confirmBeforeOpen: boolean };
  encoding: { defaultSave: 'utf-8' };
  eol: { policy: 'preserve' | 'crlf' | 'lf' | 'cr' };
  shortcuts: Record<string, string>;
  sessionRememberPassword: boolean;
}

// settings:set の部分更新用（深い部分更新を許容）
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
type AppSettingsPatch = DeepPartial<AppSettings>;
```

---

## 5. 主要処理フロー（実装レベル）

各フローで「実ファイルとメタの両方に影響する操作」は必ず DESIGN §3.2 の**同期順序**（①ストア更新 → ②実ファイル操作＋予約テーブル登録 → ③直後にメタ JSON アトミック保存）に従う。ファイル操作は §3.3 の Windows リトライを適用する。

**競合判定の2系統（判定基準が異なる点に注意）**: 本設計では変更検出の判定材料が用途により異なる。
- **保存 API の競合チェック（`memo:save` / `crypto:saveEncrypted`、§5.2/§5.5）**: **ハッシュ比較のみ**で行う。保存操作の実行時点で現在のディスク実体のハッシュを計算し、レンダラが保持する `expectedHash` と一致するかを一発判定する（明示的な保存操作の瞬間の突合であり、mtime/サイズは見ない）。
- **ファイル監視側（自己発火判定・外部変更検知、§3.3/§5.6）**: **mtime + サイズ + ハッシュの複合判定**を用いる。継続的な監視の中で自己書き込み由来のイベントを除外する精度を上げるため、複数の材料を照合する。
- 両者は目的が異なる（前者は保存時点の一発判定、後者は継続監視での自己発火除外精度の向上）ため判定基準が違う。実装者はこの非対称性を意図的なものとして扱うこと。

**自己書き込み予約テーブル登録の一元化（重要・DESIGN §3.3 包括原則の実装）**: DESIGN §3.3 は「アプリが自ら行うあらゆる FS 操作」を予約登録対象とする（`.bak` 生成・メタ/設定 JSON 保存を含む）。これを呼び出し側任せにすると登録漏れ（＝外部変更の誤検知）が起きるため、**予約登録は `atomicWrite`（および fs 層の rename/unlink/trash ラッパ）の内部責務として一元化する**。具体的には:
- `atomicWrite` は、`.bak` へ退避する旧 target（`add` 相当＝`.bak` パスの生成）と最終 target（`change`/`add`）の**両方のパスを自身で `selfWriteRegistry` に登録**してから rename を行う。temp はプレフィックス `ignored` 除外でイベントが出ないため登録不要だが、`.bak`・target 実体はプレフィックス対象外なので必ず登録が要る。
- **メモ本文・メタ JSON・アプリ設定 JSON の保存はすべてこの `atomicWrite` を経由する**ため、`metaStore`・`appSettings` の保存経路も自動的に予約登録を通る（呼び出し側が個別に登録する必要はない）。
- rename/unlink/trash（`memoFileService`・`trash.ts`）も同様に fs 層ラッパ内で対象パスを登録してから操作する。これにより §3.3 の包括原則（`.bak`・メタ/設定 JSON・リネーム・削除を含む全 FS 操作の自己発火除外）が構造的に保証される。
- 登録した予約レコードの**寿命**は、対応 chokidar イベントを消費したら即時クリア＋TTL（既定 2–3 秒）自動失効のハイブリッドとする（詳細は §5.6）。

### 5.1 起動時初期化
1. アプリ設定 JSON を読込（破損時は復旧カスケード、無ければ既定生成）。
2. ウィンドウ復元（位置/サイズ/テーマ/ツリー幅）。
3. 登録タブ一覧を取得。各タブフォルダについて `metaStore.load`（メタ JSON 読込 → §5.7 復旧カスケード → 実ファイル突合）。
4. **全文検索インデックス構築**（`searchIndex.build`）: 全タブの全メモを走査。`.txt` はメモ名＋本文、`.txtenc` は**メモ名のみ**をインデックスへ（本文は常に除外, §2.4）。
   - **ブロッキングについて（Fix11）**: v1 は DESIGN §4 の想定規模（数百〜数千メモ）ではこのステップを UI 表示前にブロッキングで構築しても許容範囲と判断する。ただし将来メモ数が大きく増えた場合は「**UI 表示後にバックグラウンドでインデックス構築する**（構築完了まで検索を段階的に有効化）」方式へ変更する余地を残す（構築処理を起動シーケンスから分離しやすい形で実装しておくことが望ましい）。
5. chokidar 監視開始（登録タブフォルダを対象。`ignored` に一時ファイルプレフィックスパターン, §3.3）。`ignored` には一時ファイルプレフィックスに加え、**Windows 環境でノイズ源となる OS 生成ファイル（`desktop.ini`・`Thumbs.db` 等）も含める**（変更通知のノイズ除去, Fix10）。
6. レンダラへ初期状態を送出、最後に開いていたメモ/タブを復元。

### 5.2 平文メモの保存フロー（`memo:save`）
1. レンダラ: CodeMirror の `doc.toString()`（LF 正規化済み）と保持していた元の改行コード種別 `eol` を IPC へ。加えて `expectedHash`（開いた時点/前回保存時のハッシュ）を渡す。
2. メイン: **競合チェック** — 現在のディスク実体のハッシュを計算し `expectedHash` と比較。不一致なら `evt:conflict` を発火し保存を中断（§3.3。競合解決 UI へ）。
3. `eol.restore(contentLF, eol)` で改行コードを復元（§2.3 必須処理）。
4. `encoding.encode(text, encoding)` でバイト列化（既定 UTF-8）。
5. `atomicWrite` を呼び出す（以降 6 は `atomicWrite` 内部の処理）。**自己書き込み予約は `atomicWrite` 内部で target・`.bak` の両パスについて期待 mtime/サイズ/ハッシュを `selfWriteRegistry` に登録する**（呼び出し側任せにしない。§5 冒頭「予約登録の一元化」参照）。
6. `atomicWrite`: **temp ファイル（プレフィックス付き）へ書込 → fsync →（世代スワップを最後に集約）旧 target を `.bak` へ rename → temp を target へ rename** の順で行う。各操作は `retry`（EBUSY/EPERM 対策）。
   - **順序の意図（クラッシュ耐性）**: 世代スワップ（`.bak` 退避と target 置換）を末尾に集約することで、**temp 書込中（メモが大きいほど長い）にクラッシュしても live な target は無傷**（復旧不要）。target 不在の窓は 2 つの rename の間の一瞬に限定され、そこでクラッシュしても target か `.bak` のいずれかが必ず存在する。逆順（先に `.bak` へ退避してから temp を書く）だと temp 書込全体の間 target 不在の窓が広がるため採らない。
   - **ディレクトリ fsync について**: 本 v1 は **Windows(NTFS) を主対象**とするため、rename 後にディレクトリエントリ自体への明示的な fsync は**行わない**（NTFS のメタデータジャーナリングに委ねる）。ext4 等でディレクトリ fsync を要する POSIX 環境への正式対応は将来検討とする（temp ファイル本体への fsync は上記のとおり実施する）。
7. 成功後、**インデックス経路①**（`searchIndex.updateMemo`）で本文を直接反映（§2.4）。
8. `SaveResult{ savedHash }` を返却。レンダラは以後の競合判定用に保持。

### 5.3 リネーム / 移動 / コピー / 複製の同期順序（§3.2）
例（メモリネーム `memo:rename`）:
1. **ストア更新**: メイン側メタ表現上で `oldName`→`newName` に参照を差し替え（重複チェック・サニタイズを先に実施。NG なら即エラー返却、ファイル操作しない）。
2. **実ファイル操作**: `fs.rename(old.txt|txtenc, new.txt|txtenc)`。直前に `selfWriteRegistry` へ old（unlink 相当）と new（add 相当）を登録。`retry` 適用。
3. **直後にメタ JSON アトミック保存**（§5.2 と同じ atomicWrite）。
4. インデックス経路①でメモ名キーを更新。
- 移動/コピー（`memo:move`）は複数ファイル + 2 つのタブのメタに影響。各ファイル操作を予約登録し、両タブのメタを操作完了直後にアトミック保存。コピー時（Ctrl）は元を残す。
- クラッシュ時の隙は復旧カスケードが安全網（§3.2 受容済みトレードオフ）。

### 5.4 暗号化変換フロー（平文→`.txtenc`、`crypto:encryptMemo`, §2.9）
1. パスワード確認入力（レンダラのダイアログ）→ password をメインへ。
2. メイン: 平文 `.txt` を読み込み（メモリ）。新規 salt + scrypt で鍵導出（**非同期 `crypto.scrypt` を `await`**。§4.3。イベントループをブロックしない）、新規 IV で AES-256-GCM 暗号化、`.txtenc` コンテナを構築（§4.3）。
3. `selfWriteRegistry` に `.txtenc`（add）と 平文 `.txt`（unlink）を登録。
4. `atomicWrite` で `.txtenc` を書込（temp→fsync→rename）。**書き込み永続化を fsync で確認**。
5. **確認後に**元の平文 `.txt` を**ごみ箱を経由せず直接 `fs.unlink`**（§2.9 平文原本削除。順序厳守=`.txtenc` 永続化後に削除）。
6. インデックス経路①: 該当メモを「本文除外・メモ名のみ」に更新（§2.4）。
7. セッション鍵ストアに導出鍵を保持（そのまま開封状態にしてよい）。
- 途中クラッシュ時: `.txtenc` rename 前なら平文が残り再開可能。`.txtenc` 生成後・unlink 前なら平文と暗号版が一時併存 → 起動時突合で同名衝突を検出したら暗号版を優先し平文を要確認として扱う（§8 整合メモ）。

### 5.5 開封 / 保存 / パスワード変更 / ロック（§2.9）
- **開封 `crypto:open`**: `.txtenc` を読み、ファイル内 KDF パラメータ+salt で鍵導出（**非同期 `crypto.scrypt` を `await`**。§4.3。UI をフリーズさせない）、IV+tag で復号。認証タグ検証失敗→`DECRYPT_FAILED`（「パスワードが違います」、本文は返さない）。成功→**セッション鍵ストアへキー `(tabId, memoName)`（またはメモ絶対パス）で鍵保持**（`memoName` 単体をキーにしない, §1.4/§2.1）、平文本文+eol に加え **`.txtenc` 現状の `hash`**（次回保存の競合判定用。**ディスク上の `.txtenc` ファイル全体のバイト列のハッシュ**, §4.4/Fix4）をレンダラへ返す。レンダラは平文メモと同様この hash を保持する。
- **保存 `crypto:saveEncrypted`**: **競合チェック** — 現在のディスク上 `.txtenc` のハッシュを計算し、レンダラから渡された `expectedHash`（開封時/前回保存時の hash）と比較。不一致なら `evt:conflict` を発火し保存中断（平文 `memo:save` と対称の競合検出。§3.3。watch は `.txtenc` も監視対象のため暗号化メモでも競合検出が必要）。一致時のみ → セッション鍵で**新 IV** 生成し再暗号化 → `atomicWrite`（`.bak` も暗号化済み）→ 新ハッシュを `SaveResult{ savedHash }` で返却。salt は流用。自動保存は低頻度デバウンス（§2.6, 既定 5s）。
- **パスワード変更 `crypto:changePassword`**: ①旧 PW で復号確認 → ②新 PW → ③**新 salt+新 IV** で再暗号化 → ④temp 書込+fsync → ⑤アトミック rename（§2.9 手順）。失敗時は rename しないだけでロールバック不要。
- **ロック `crypto:lock`（未保存データの扱いを含む）**: 実行手順は以下。
  1. **ロック実行前に未保存の変更（dirty 状態）があるかをチェックする**。dirty の場合は、**メモ切り替え時と同様にロック実行前に自動保存（`crypto:saveEncrypted`）を行ってからロックする**（DESIGN §2.6 の「メモ切り替え時」自動保存トリガーに準じ、(再)ロックも保存機会として扱う。無確認でのデータ破棄はしない）。既定は自動保存を優先する。ユーザーが明示的に「保存せず破棄」を選べる UI をレンダラ側に用意するかは developer 判断とするが、**既定挙動は自動保存**とし、確認なしに編集内容を捨てない。
  2. 保存完了後（または dirty でない場合は即）、メイン側で当該メモのセッション鍵をストアから破棄する（キー `(tabId, memoName)`）。
  3. レンダラは CodeMirror ドキュメント + Undo 履歴を破棄（§2.9 厳格破棄）。
  - メモ切替/終了時も同様（切替/終了前に dirty なら自動保存 → 鍵破棄 → 履歴破棄）。

### 5.6 ファイル監視 → 自己発火除外 → インデックス更新（§3.3 / §2.4）
1. chokidar が `add/change/unlink` を発火（一時ファイルは `ignored` で最初から発火しない）。
2. **デバウンス**（100–300ms）で集約。
3. **自己発火判定**: `selfWriteRegistry` を照合。target パスの期待 mtime/サイズ/ハッシュ（unlink は不在）が一致 → 自己発火として**破棄**。予約レコードの寿命は**ハイブリッド方式**とする:
   - **マッチしたら即時クリア**: 対応する chokidar イベントを 1 回消費した時点でそのレコードを即座に削除する。これにより、同一パスへの以後の変更（＝真の外部変更）を誤って自己発火と判定しない。
   - **TTL フォールバック（既定 2–3 秒）**: 何らかの理由で対応イベントが発火しなかった場合に予約テーブルが肥大化しないよう、登録から一定時間（既定 **2–3 秒程度**）で自動失効させる保険を併用する。TTL は chokidar のデバウンス（100–300ms）に対し十分長く取る。Windows は OS の I/O バッファリングにより実際のイベント発火まで数十〜数百ミリ秒のタイムラグが生じ得るため、デバウンス時間より大きく余裕を持たせた値とする。
4. 外部変更と判定した場合:
   - 対象メモが**編集中（未保存変更あり）**なら → `evt:conflict` 発火。競合解決ダイアログ表示中は当該メモの自動保存・エディタ入力を**ロック**（§3.3）。解決確定後にロック解除。
   - 編集中でなければツリー/本文へ反映（`evt:externalChange`）し、**インデックス経路②**（監視経由）で該当メモを更新（`.txtenc` は名前のみ）。
- **経路の分離厳守**（§2.4）: アプリ内変更はインデックス経路①（保存完了時に直接）、外部変更のみ経路②（監視経由）。監視で破棄された自己発火はインデックスに触れない（経路①で既に反映済み）。

### 5.7 メタ破損復旧カスケード（§3.2）
1. メタ JSON パース失敗を検知。
2. 直近 `.bak` があれば読込を試行 → 成功すれば採用。
3. 失敗/`.bak` 無し → フォルダ直下実ファイル（`.txt`/`.txtenc`, 直下のみ, リンク無視）から**フラット構造でメタ再生成**（順序=名前順等の既定、階層/ラベルは失う）。
4. `evt:metaRecovered` でユーザーへ通知。再生成メタは次回アトミック保存で永続化。
- 「正常だがファイル 1 件参照欠落」の部分修復は行わない（HANDOFF 合意・対応不要）。

### 5.8 リンク処理（§2.8）
- **装飾**: レンダラ `editor/links.ts` が本文から URL(`http/https/www./ftp://`)、メール、ファイルパス（ドライブレター/`.\`/`..\`/`file://`）、`memo:` を検出し CodeMirror デコレーション付与。
- **外部起動**: クリック（既定 Ctrl+クリック, 設定可）→ 確認ダイアログ（既定 ON）→ `link:openExternal`。メインで相対パスを `path.resolve(<管理フォルダ絶対パス>, rel)` に変換して `shell.openPath`／URL・mailto は `shell.openExternal`。**シェル文字列連結は使わない**（§2.8/§6）。
- **memo: 解決**: `link:resolveMemo` がメイン側で `memo:メモ名` / `memo:タブ名/メモ名` / `memo:タブ名/` を解決（`.txt`/`.txtenc` 両対象、拡張子除去名で照合、タブ名重複禁止・同名メモ非共存で一意, §2.8）。解決先が `.txtenc` なら開封フロー（§5.5）へ。解決不能は null（エラー出さない）。番号/位置系記法は v1 任意（実装余力次第）。

### 5.9 名前サニタイズ / バリデーション（§3.1）
- 入力/リネーム時に Windows 禁止文字（`\ / : * ? " < > |`・制御文字）、予約名（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`）、前後空白・末尾ピリオドを検出。
- **リアルタイム表示**: レンダラ入力欄で即時バリデーションメッセージ。`/` 等は `-`/`_` への置換候補をワンクリック提示（§3.1 UX）。
- タブ名は重複禁止（大文字小文字・正規化後で比較, §2.1）。メモ名は同一タブ内で `.txt`/`.txtenc` 統一空間で重複禁止（§3.1）。
- 長パス（絶対パスが 260 文字超）を検出したら `LONG_PATH` として警告（v1 は正式対応せず既知の制限, §4）。
- **AutoReName の発火制御（Fix12, DESIGN §2.2）**: 本文の最初の非空行を自動的にメモ名にする AutoReName は、キー入力毎に即時リネームしない（リネーム→メタ保存→watcher→インデックス更新のカスケードが毎入力走ると負荷過大なため）。**(a) 最初の非空行の内容が実際に変化した場合のみ発火し、(b) 編集停止から 500〜1000ms 程度のデバウンスを挟んでから**リネーム処理（名前サニタイズ/重複回避を経て `memo:rename` 相当）を実行する。暗号化メモ（`.txtenc`）は AutoReName 対象外（§2.9/M6）。

---

## 6. エラーハンドリング方針

| 事象 | 方針 | 参照 |
|------|------|------|
| Windows ロック（EBUSY/EPERM 等） | 書込/rename/unlink に短いリトライ（例 3–5 回, 50–200ms バックオフ）。全滅時のみ `IO_LOCKED` をユーザー表示 | §3.3 |
| ごみ箱送り失敗（ネットワークドライブ/権限） | `TRASH_FAILED` → `evt:trashFallback` でUI に「直接削除しますか？」確認。**承諾時のみ** `memo:delete` を `forceDirect:true` で再 invoke し `fs.unlink` 相当で直接削除。`forceDirect` 無の再試行では再びごみ箱を試みるだけなので失敗ループにならない。無確認削除しない | §2.6 |
| メタ JSON 破損 | 復旧カスケード（`.bak`→フラット再生成→通知）。メモ本体は決して失わない | §3.2/§5.7 |
| アプリ設定 JSON 破損 | 同様にアトミック保存+`.bak`+復旧。全滅時は既定設定で再生成し通知 | §3.2 |
| 暗号復号失敗（誤 PW/改ざん） | 認証タグ検証失敗を `DECRYPT_FAILED`。「パスワードが違います」。本文は一切返さない | §2.9 |
| 外部編集競合 | mtime+サイズ+ハッシュで判定。編集中なら `evt:conflict`、解決ダイアログ中は自動保存/入力ロック | §3.3 |
| 名前重複/禁止文字 | ファイル操作前に検出しブロック（`NAME_DUPLICATE`/`NAME_INVALID`）。実ファイルは触らない | §2.1/§3.1 |
| 保存中クラッシュ | atomicWrite は「temp 書込→fsync→旧 target を `.bak` へ rename→temp を target へ rename」の順（世代スワップを末尾に集約, §5.2）。temp 書込中クラッシュでも **live target は無傷**、世代スワップ中クラッシュでも target か `.bak` のいずれかが必ず存在。暗号変換は `.txtenc` 永続化後に平文削除で平文喪失を防止 | §2.6/§2.9 |
| 長パス | `LONG_PATH` 警告。v1 は正式対応外 | §4 |
| 予期せぬ例外 | IPC 境界（`ipcMain.handle`）で必ず catch し `Result{ok:false, code:'UNKNOWN'}` 化。プロセスは落とさない。**レンダラへ返す `Result` エラーは `code`/`message`/`path?` のみに留め**（内部情報を UI へ露出しない）、**元の OS エラーコード（`err.code`）・例外名・スタックはメインプロセス側の内部ログにのみ記録する**（Fix8, 下記） | §6 |

- **内部診断ログ方針（Fix8）**: `Result` のエラーオブジェクトはレンダラ向けに `code`/`message`/`path?` のみを保つ（診断詳細を UI/レンダラへ公開しない）一方、**障害解析のためメインプロセス側の内部ログ**（`console.error` またはログファイル等、出力先の実装詳細は developer 判断）には、捕捉した例外の**元の OS エラーコード（`err.code`, 例 `EBUSY`/`EPERM`/`ENOENT`）・例外名・スタックトレース**を記録する。とりわけ `UNKNOWN` へ丸めた例外は、丸める前の生の情報を必ず内部ログに残し、後から原因追跡できるようにする。**鍵・パスワード・復号平文は内部ログにも出力しない**（セキュリティ不変条件を内部ログでも順守）。
- **セキュリティ不変条件**（実装で常に保証）: 鍵/パスワードはメインに閉じレンダラへ渡さない／復号平文をディスクへ書き出さない・インデックスに入れない・**内部ログにも出さない**／外部起動は OS 標準 API のみでシェル連結しない／`contextIsolation:true`・`nodeIntegration:false`・`sandbox:true`／preload は限定 API のみ公開。

---

## 7. 実装順序・マイルストーン

段階的に動作確認しながら積み上げる。各 M の完了時点で reviewer→tester に回せる粒度を意識。

- **M0: 足場**  electron-vite プロジェクト初期化、TS strict、3 プロセス雛形、`contextIsolation/nodeIntegration/sandbox` 設定、`shared/ipc-contract.ts` と `Result` 型、空の 3 ペイン UI + テーマ切替（§2.5）。
- **M1: ファイル層コア（平文）**  `atomicWrite`+`.bak`、`tempNaming`、`retry`、`encoding`（2 段フォールバック）、`eol`（検出/復元）、`memoFileService` の read/save、`tabService`（フォルダ登録・直下走査・リンク無視）、`metaStore`（読書き+復旧カスケード）。IPC: tab/memo の基本。→ 平文メモの開く/編集/保存が一通り動く。
- **M2: ツリー UI + メタ同期**  仮想化ツリー、開閉/複数選択、追加位置、リネーム/削除（ごみ箱+フォールバック）/複製/移動・コピー、DND、§3.2 同期順序の実装、サニタイズ UX（§5.9）。
- **M3: 検索**  現在メモ内検索・置換・正規表現（CodeMirror 内）、全文検索メモリ内インデックス（起動時構築+経路① 差分更新）、検索履歴、結果ジャンプ。
- **M4: ファイル監視**  chokidar + `ignored` プレフィックス除外 + `selfWriteRegistry` 自己発火除外 + デバウンス + 競合判定（mtime+サイズ+ハッシュ）+ 解決ダイアログ/ロック + 経路② インデックス更新（§3.3/§2.4）。
- **M5: リンク機能**  装飾（URL/mail/path/`memo:`）、外部起動（確認+`path.resolve`+OS API）、`memo:` 解決・遷移（§2.8）。
- **M6: パスワード暗号化**  `cipher`/`encFormat`/`sessionKeyStore`、暗号化変換（平文原本直接削除・順序厳守）、開封/保存（新 IV）/パスワード変更/ロック、暗号化メモの検索・AutoReName 除外・低頻度自動保存・厳格な履歴破棄（§2.9）。
- **M7: 仕上げ**  ステータスバー、折り返し/タブ幅/行番号/可視化トグル、フォントサイズ、ショートカット、トレイ常駐（最小）、AutoReName（最初の非空行, 暗号化除外。**最初の非空行が実際に変化した場合のみ + 編集停止から 500〜1000ms デバウンス後に発火**。キー入力毎の即時リネームはしない, §5.9/Fix12）、設定画面、`schemaVersion`/`appVersion` マイグレーション土台、electron-builder ポータブル配布。

依存関係: M1 は全ての土台。M4 は M1/M2 完了後。M6 は M1（atomicWrite/eol）と M3（インデックス除外）に依存。M5 は M1/M2 後ならいつでも可。

---

## 8. DESIGN.md との整合メモ（developer/reviewer への申し送り）

DESIGN.md の設計判断は変更していない。実装に落とす過程で判断の余地があった点・DESIGN の記述と実装単純化の間で微調整した点を明示する。**いずれも DESIGN の意図に反しないと判断したが、reviewer は要確認**。

1. **暗号化状態の真実源**（§4.1）: **拡張子 `.txtenc` を単一真実源**とし、メタ側の暗号フラグは冗長情報として持たない（メタと実体の二重管理による不整合を避けるため）。ツリー表示の暗号アイコンは走査時の拡張子から導出する。DESIGN の「パスワード/鍵はメタに保存しない」制約は完全順守。※reviewer 指摘を受け、DESIGN §2.9 の当該記述も「真実源は拡張子 `.txtenc`、メタJSONには暗号フラグを冗長に持たせない」に更新済みで、PLAN と DESIGN は整合済み（字面矛盾は解消）。

2. **復号平文のレンダラ供給**（§1.4）: エディタ表示のため復号本文（平文テキスト）はレンダラへ渡す必要がある。DESIGN §2.9 が禁じる「鍵/パスワードのレンダラ露出」「平文のディスク書き出し」「平文のインデックス取り込み」には該当しないと解釈した。鍵はメインのセッション鍵ストアに閉じる。→ 解釈の妥当性を reviewer 確認対象。

3. **暗号化変換中クラッシュで平文・暗号版が併存した場合**（§5.4）: DESIGN は「`.txtenc` 永続化後に平文削除」で平文喪失を防ぐと明記するが、`.txtenc` 生成済み・平文 unlink 前のクラッシュで同名の `.txt` と `.txtenc` が一時併存し得る。§3.1 の「同名の平文・暗号版が同時に存在しない」不変条件を起動時突合で回復するため、本 PLAN では「併存検出時は暗号版を優先し、平文 `.txt` はユーザー確認を促す（自動削除はしない）」方針を補った。DESIGN に明示手順が無い縁ケースの補完であり、設計判断の変更ではない。→ 方針の可否を reviewer 確認対象。

4. **scrypt コストパラメータの具体値**（§4.3）: DESIGN は「十分な強度となる値」とのみ規定。本 PLAN は **N=32768（2^15）/r=8/p=1/keyLen=32**（2026 年基準で interactive 水準よりやや高強度側）を初期既定として提示しつつ、**ファイルに記録して復号時はファイル値を使う**設計（将来引き上げ可能）とした。実機体感に応じ developer が確定してよい。※当初 N=16384 案を reviewer 指摘（2026 年基準でやや低め）を受け 2^15 へ引き上げ。

5. **未確定だった実装時確定項目の既定化**（§0）: UI=React、エディタ=CodeMirror 6、ビルド=electron-vite+electron-builder、リンク操作の既定=Ctrl+クリック+確認ON を本 PLAN で確定既定とした。いずれも DESIGN が「実装時に確定」「既定 ON 推奨」等としていた範囲内。

6. **リネーム/移動/コピー/複製操作の外部変更競合は非検出（受容済みリスク）**（§5.3）: リネーム/移動/コピー/複製操作は対象ファイルの内容変更を伴わない操作であるため、保存フロー（`memo:save`）のような `expectedHash` 競合検出は行わない。ごく稀に、リネーム操作の直前に外部プロセスが同一ファイルを変更した場合、その外部変更内容はリネーム後もそのまま保持される（データは失われない）が、外部変更検知の通知（`evt:conflict` 等）は発火しない可能性がある、という受容済みの制限がある。個人用途の v1 スコープでは、この極めて低頻度のレースコンディションに対する追加の競合検出機構は実装しない（ファイル監視は依然としてリネーム後のパスに対して有効であり、後続の変更は通常通り検知される）。

7. **暗号化変換中の外部変更競合は非検出（受容済みリスク）**（§5.4）: 暗号化変換フローは平文読み込み時点の内容を暗号化する。読み込みから unlink までの間（通常は非常に短時間）に外部プロセスがその平文ファイルを変更した場合、その外部変更は変換結果の `.txtenc` に反映されず失われる可能性がある、という受容済みの制限がある。個人用途の v1 スコープでは、暗号化変換操作中に対象ファイルが外部から同時編集される状況は極めて稀と判断し、読み込み〜unlink 間の追加の変更検知機構（例: unlink 直前に再度ハッシュを比較する等）は実装しない。ユーザーが暗号化変換対象のメモを外部エディタで同時編集しないことを前提とする。

上記 1–7 以外に、DESIGN.md の確定判断と矛盾する箇所・実装不可能な箇所は発見されなかった。
