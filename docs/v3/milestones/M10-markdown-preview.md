# M10 — Markdown＋ライブプレビュー

> **本マイルストーンは実行コストが大きいため、ユーザー判断で3分割済み。developerへの実装依頼は以下の分割後ドキュメントを使うこと（本ファイルは経緯保存・全体像参照用）:**
> - [M10a-markdown-format-core.md](M10a-markdown-format-core.md) — 保存形式基盤・全文検索反映（`.md`拡張子対応、`memo:convertFormat`、暗号化`format`フィールド）
> - [M10b-markdown-live-preview.md](M10b-markdown-live-preview.md) — 装飾ライブプレビュー描画・サニタイズ・右クリックコマンド（M10a必須）
> - [M10c-markdown-toolbar-ui.md](M10c-markdown-toolbar-ui.md) — ツールバー・ソース/プレビュー切替・画像貼り付け・変換UI（M10a/M10b必須）
>
> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは機能2「Markdown＋ライブプレビュー」を扱う。[M8](M8-node-lock-core.md)/[M9](M9-node-lock-session-ops.md)（ノードロック）とは**独立**しており、いずれの順序で着手してもよい。

## ゴール（PLANv3 §1.1/§1.3/§2.3/§5.6〜§5.9）
`.md`拡張子の新設、文字装飾（色/太字/文字サイズ）のライブプレビュー描画、右クリック装飾コマンド、専用ツールバー、ソース/プレビュー切替、画像貼り付け（サイズ警告付きBase64埋め込み）、`.txt`⇔`.md`変換（装飾/画像検出時の確認ダイアログ）、暗号化メモの`format`フィールド対応、全文検索インデックスへのタグ除去反映までが一通り動く状態がゴール。

## 依存関係
- 先行: v1 **M1**（ファイル層コア）、**M3**（全文検索インデックス）、**M6**（`.txtenc`フォーマット・暗号化変換フロー、`format`フィールドの追加先）。
- [M8](M8-node-lock-core.md)/[M9](M9-node-lock-session-ops.md)（ノードロック）への依存・被依存は無い。

## このフェーズで扱う IPC チャネル（PLANv3 §2.3）
| チャネル | 変更内容 |
|----------|----------|
| `memo:create` | 引数に `format?: 'plain' \| 'markdown'`（省略時`'plain'`）を追加。`'markdown'`指定時は拡張子`.md`でファイル作成 |
| `memo:convertFormat`（新規） | `{ tabId, memoName, targetFormat: 'txt' \| 'md' }` → `Result<MemoInfo>`。拡張子のみリネーム、本文は無変更（DESIGNv3 §2.4）。`.md`→`.txt`時の装飾/画像検出・確認ダイアログはレンダラ側で本IPC呼び出し前に完結させる（下記フロー参照） |
| `crypto:encryptMemo` | 引数変更なし。元ファイルの拡張子(`.txt`/`.md`)から`format`を自動判定し`.txtenc`の`format`フィールドへ反映（DESIGNv3 §2.5 Q8） |
| `crypto:decryptMemoToPlain` | 引数変更なし。`.txtenc`の`format`フィールドに従い`.txt`/`.md`いずれかへ復元 |

装飾操作・プレビュー描画・画像Base64埋め込み・変換前の警告判定はすべてレンダラ内完結のためIPC不要（メインプロセスの変更は上記4チャネルとファイル走査/索引化の拡張のみ）。

## このフェーズで扱う型/データ構造（PLANv3 §4）
```ts
// .txtenc フォーマット拡張（確定・DESIGNv3 §2.5 Q8）
interface TxtEncFile {
  // ...既存フィールド（magic/formatVersion/kdf/cipher/eol/hint/ciphertextB64、v1 data-model.md参照）
  format?: 'plain' | 'markdown';  // 省略時 'plain'（後方互換）
}

// Markdown サニタイズ許可リスト（確定・DESIGNv3 §2.3）
const MARKDOWN_ALLOWED_TAGS = ['span', 'img'] as const;
const MARKDOWN_ALLOWED_SPAN_STYLE_PROPS = ['color', 'font-size', 'font-weight'] as const;
const MARKDOWN_ALLOWED_IMG_ATTRS = ['src', 'width', 'height'] as const;
const MARKDOWN_IMAGE_SRC_PATTERN = /^data:image\/(png|jpe?g|gif|webp);base64,/;
const MARKDOWN_IMAGE_SIZE_WARN_BYTES = 500 * 1024; // 目安。DESIGNv3 §2.6「数百KB〜1MB」の下限寄り（developer調整可）
```

**サニタイズ実装上の注意**: `DOMPurify`を使う場合、`ALLOWED_TAGS`/`ALLOWED_ATTR`で`span`/`img`とその属性は絞れるが、`style`属性の**CSSプロパティ単位**の絞り込み（`color`/`font-size`/`font-weight`のみ許可、`position`/`opacity`等は除去）は標準機能だけでは足りないため、`uponSanitizeAttribute`フックで追加実装が必要（PLANv3 §0）。

## このフェーズで扱う処理フロー（PLANv3 §5.6〜§5.9）

### Markdown装飾コマンド実行フロー
1. レンダラ: 右クリックメニュー「文字色/太字/文字サイズ」選択→対応コマンドを`changeByRange`で実行し、選択範囲を`<span style="...">...</span>`でラップ/アンラップ（既存`textCommands.ts`と同パターン、Undo単位も同様に1トランザクション=1Undo, DESIGNv3 §2.2）。
2. CodeMirrorの`ViewPlugin`（`markdownDecorations.ts`）が文書変更を検知し、`markdownSanitize.ts`の許可リストでサニタイズしたHTMLを見た目として描画する（実データは常にMarkdownテキストのまま）。
3. 保存は既存`memo:save`/`crypto:saveEncrypted`をそのまま使用（追加IPC不要）。

### 画像貼り付けフロー
1. レンダラ: クリップボード/ドロップの画像データを取得→バイト数を計測（貼付け時点で既にメモリ上にあるため追加I/O不要）。
2. `MARKDOWN_IMAGE_SIZE_WARN_BYTES`超なら実サイズ（約◯MB）を明記した確認ダイアログ（既存`ConfirmDialog`）を表示。
3. 続行時、Base64化し`![](data:image/png;base64,...)`をカーソル位置へ挿入（IPC不要、全てレンダラ内完結）。

### `.txt`↔`.md`変換フロー
- **`.txt`→`.md`**: `memo:convertFormat{targetFormat:'md'}` → 拡張子のみリネーム（本文無変更, DESIGNv3 §2.4）。
- **`.md`→`.txt`**: レンダラが現在の本文から装飾タグ(`<span`)/画像データURI(`data:image/`)の有無を正規表現で検出→検出時のみ確認ダイアログ表示（「この操作を行うと、色などの装飾用タグや画像データがそのまま文字として表示されるようになります。続行しますか？」）→続行後に同一の`memo:convertFormat{targetFormat:'txt'}`を呼ぶ（本文無変更、拡張子のみ）。
- 暗号化メモの場合は`crypto:encryptMemo`/`crypto:decryptMemoToPlain`実行時に元拡張子(`.txt`/`.md`)から`format`を自動判定し`.txtenc`の`format`フィールドへ反映する（新規IPCパラメータは不要）。

### 全文検索インデックスへのMarkdown反映
`searchIndex.ts`のインデックス構築/差分更新時、`.md`ファイルは本文を許可リストタグ除去（プレーンテキスト化）した上で通常の`.txt`と同様に本文インデックス対象にする（DESIGNv3 §2.6 Q11）。マッチ判定はタグ除去後のプレーンテキスト基準の完全一致とし、ライブプレビュー上のハイライト位置変換はbest-effortでよい。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/main/fs/tabService.ts`（拡張）— `scanTabFolder`が`.md`を`.txt`と並ぶ「平文相当」の第三拡張子として認識
- `src/main/fs/memoFileService.ts`（拡張）— `.md`のread/write/rename/moveを`.txt`と同一ロジックで扱う（拡張子だけ分岐）
- `src/main/ipc/memoHandlers.ts`（拡張）— `convertFormat`ハンドラを追加
- `src/main/search/searchIndex.ts`（拡張）— `.md`の本文をタグ除去してから索引化
- `src/renderer/editor/markdownSanitize.ts`（新規）— DOMPurify設定 + 許可リスト定数 + style属性のプロパティ単位フィルタ
- `src/renderer/editor/markdownDecorations.ts`（新規）— CodeMirror ViewPlugin、ライブプレビュー描画
- `src/renderer/editor/decorationCommands.ts`（新規）— 文字色/太字/文字サイズの`changeByRange`コマンド
- `src/renderer/editor/imagePaste.ts`（新規）— 貼り付け/ドロップ画像→サイズ計測→警告→Base64埋め込みテキスト挿入
- `src/renderer/components/Editor/MarkdownToolbar.tsx`（新規）— ライブプレビュー編集中専用ツールバー（配置・ボタン構成はdeveloper裁量）

## このフェーズのエラーハンドリング
新規エラーコードは無し。既存の`NAME_DUPLICATE`/`NAME_INVALID`等をそのまま再利用する（PLANv3 §3 整合性チェック）。サニタイズで許可リスト外のタグ・属性・CSSプロパティ（`<script>`・`on*`イベント属性・`javascript:`スキーム等を含む）を検出した場合は例外を出さず**黙って除去**する（プレビュー描画時に必ず除去することがセキュリティ不変条件, DESIGNv3 §2.3）。

## DESIGNv3.md の関連セクション
- 目的・編集体験（ライブプレビュー方式、ソース切替）: §2.1。装飾操作・Undo粒度: §2.2。
- 安全性（許可リスト方式、styleプロパティ単位の絞り込み、img属性制限）: §2.3。
- 保存形式・拡張子（`.md`新設、変換フロー、変換前警告）: §2.4。
- 暗号化メモとの関係（`format`フィールド）: §2.5。既存機能との相互作用（リンク・全文検索・画像サイズ警告）: §2.6。
- 許可するMarkdown記法の範囲（装飾+画像のみ、構造記法は対象外）: §2.7。

## PLANv3.md §7 実装補完事項の関連項目
なし（§7.1〜§7.7はすべてノードロック機能に関する項目）。

## reviewer/tester への申し送り
- サニタイズが本当に許可リスト外を除去できているか（`<script>`/`on*`イベント属性/`javascript:`スキーム/許可外CSSプロパティ）を重点確認すること。装飾はあくまで見た目の変換であり、実行可能なコードを本文から生成させないことがセキュリティ不変条件。
- `.md`→`.txt`変換時、装飾タグ・画像データURIを含む本文で確認ダイアログが正しく出るか（検出しない場合は無警告で変換されるか）を確認すること。
