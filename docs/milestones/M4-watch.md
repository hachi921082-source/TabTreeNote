# M4 — ファイル監視

> 派生ドキュメント。正本は [PLAN.md](../../PLAN.md) / [DESIGN.md](../../DESIGN.md)。横断ルールは [00-core-principles.md](../00-core-principles.md)、型は [data-model.md](../data-model.md)。

## ゴール（PLAN §7 M4）
chokidar + `ignored` プレフィックス除外 + `selfWriteRegistry` 自己発火除外 + デバウンス + 競合判定（mtime+サイズ+ハッシュ）+ 解決ダイアログ/ロック + 経路② インデックス更新（DESIGN §3.3 / §2.4）。

## 依存関係
- 先行: **M1/M2 完了後**（PLAN §7 依存関係）。`atomicWrite`/`selfWriteRegistry` 登録の一元化（M1）とメモ操作一式（M2）、インデックス経路①（M3）が前提。

## このフェーズで扱う IPC チャネル / 通知（PLAN §2.7）
主にメイン→レンダラ通知（`webContents.send`）:
| イベント | ペイロード | 説明 |
|----------|-----------|------|
| `evt:externalChange` | `{ tabId, changes }` | 外部変更を検知しツリー/本文に反映が必要 |
| `evt:conflict` | `{ tabId, memoName }` | 編集中メモに外部変更（競合ダイアログを開く。解決中ロック） |
| `evt:indexUpdated` | `{ tabId? }` | 検索インデックス更新（UI 側の再検索が必要な場合） |
| `evt:metaRecovered` | `{ tabId, mode }` | メタ破損復旧カスケード発動の通知 |
| `evt:opError` | `{ code, message, path? }` | リトライ後も失敗した I/O エラー等 |

（`memo:save` / `crypto:saveEncrypted` の `expectedHash` 競合検出はこの M で有効化される競合フローと対になる。）

## このフェーズで扱う型/データ構造
- `selfWriteRegistry` の予約レコード: 対象パスと「期待する mtime/サイズ/コンテンツハッシュ（削除の場合は不在）」。
- 競合判定材料: mtime + サイズ + ハッシュ（[00-core-principles.md](../00-core-principles.md) §5 の 2 系統のうち監視側）。
- hash は実ファイル全体のバイト列（§6 / [data-model.md](../data-model.md) §4）。

## このフェーズで扱う処理フロー

### ファイル監視 → 自己発火除外 → インデックス更新（PLAN §5.6 全文相当）
1. chokidar が `add/change/unlink` を発火（一時ファイルは `ignored` で最初から発火しない）。
2. **デバウンス**（100–300ms）で集約。
3. **自己発火判定**: `selfWriteRegistry` を照合。target パスの期待 mtime/サイズ/ハッシュ（unlink は不在）が一致 → 自己発火として**破棄**。予約レコードの寿命は**ハイブリッド方式**:
   - **マッチしたら即時クリア**: 対応 chokidar イベントを 1 回消費した時点でレコードを即座に削除（同一パスへの以後の真の外部変更を誤判定しない）。
   - **TTL フォールバック（既定 2–3 秒）**: 対応イベントが発火しなかった場合の肥大化防止。chokidar デバウンス（100–300ms）より十分長く、Windows の I/O バッファリング遅延（数十〜数百 ms）に余裕を持たせる。
4. 外部変更と判定した場合:
   - 対象メモが**編集中（未保存変更あり）**なら → `evt:conflict` 発火。競合解決ダイアログ表示中は当該メモの自動保存・エディタ入力を**ロック**。解決確定後にロック解除。
   - 編集中でなければツリー/本文へ反映（`evt:externalChange`）し、**インデックス経路②**（監視経由）で該当メモを更新（`.txtenc` は名前のみ）。
- **経路の分離厳守**（DESIGN §2.4）: アプリ内変更は経路①（保存完了時に直接、M3）、外部変更のみ経路②（監視経由）。監視で破棄された自己発火はインデックスに触れない（経路①で既に反映済み）。

### 予約登録の一元化（PLAN §5 冒頭 / DESIGN §3.3 包括原則）
`atomicWrite`・fs 層 rename/unlink/trash ラッパの内部で対象パスを `selfWriteRegistry` へ登録済み（M1/M2 で組み込み）。M4 では**照合・消費・TTL 失効**を実装する。→ 全体像は [00-core-principles.md](../00-core-principles.md) §4。

### 競合判定（DESIGN §3.3）
- 監視側は mtime + サイズ + ハッシュの複合判定（保存 API のハッシュのみ判定とは非対称。[00-core-principles.md](../00-core-principles.md) §5）。
- **コンフリクト解決中のロック**: ダイアログ表示中は対象メモの自動保存とエディタ入力を一時ロックし、解決確定後にロック解除（先祖返り防止）。

### Windows ロック対策（DESIGN §3.3）
- 書込・rename・削除に短いリトライ（[00-core-principles.md](../00-core-principles.md) §7）。

## このフェーズで扱うディレクトリ/ファイル（PLAN §3）
- `src/main/watch/watcher.ts` — chokidar 起動・`ignored`・デバウンス。`ignored` には一時ファイルプレフィックスに加え Windows の OS 生成ファイル（`desktop.ini` / `Thumbs.db` 等）も含める（Fix10）
- `src/main/watch/selfWriteRegistry.ts` — 自己書き込み予約テーブル。イベント消費で即時クリア + TTL(既定 2–3 秒)自動失効のハイブリッド
- `src/main/watch/conflict.ts` — mtime+サイズ+ハッシュ競合判定
- レンダラ `src/renderer/components/dialogs/` — 競合解決ダイアログ

## このフェーズのエラーハンドリング（[00-core-principles.md](../00-core-principles.md) §8）
関連行: 「外部編集競合」（編集中なら `evt:conflict`、解決ダイアログ中は自動保存/入力ロック）、「Windows ロック」、「予期せぬ例外」（`evt:opError`）。

## DESIGN.md の関連セクション
- 外部変更への追従・自己発火除外・競合判定・Windows ロック・解決中ロック: DESIGN §3.3。
- インデックス差分更新の 2 経路: DESIGN §2.4。

## PLAN §8 整合メモの関連項目
- **メモ 6**（リネーム/移動/コピー/複製操作の外部変更競合は非検出＝受容済みリスク。ファイル監視は依然としてリネーム後のパスに対して有効）。
- **メモ 7**（暗号化変換中の外部変更競合は非検出＝受容済みリスク。読み込み〜unlink 間の追加検知は実装しない。M6 と共通）。
