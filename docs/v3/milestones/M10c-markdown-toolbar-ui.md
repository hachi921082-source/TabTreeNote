# M10c — Markdownツールバー・ソース/プレビュー切替・画像貼り付け・変換UI

> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは、当初の [M10-markdown-preview.md](M10-markdown-preview.md)（実行コストが大きいためユーザー判断で3分割）のうち、
> **専用ツールバー・ソース/プレビュー切替・画像貼り付け・`.txt`⇔`.md`変換のUI（検出・確認ダイアログ）**を扱う。3分割の最後。

## ゴール（PLANv3 §5.7/§5.8のUI側/§2.3）
`.md`メモ編集時専用のツールバーが表示され、ソース/プレビュー切替が行えること、クリップボード/ドロップの画像貼り付けがサイズ警告付きでBase64埋め込みされること、`.txt`⇔`.md`変換がツールバー等から実行でき、`.md`→`.txt`変換時は装飾/画像データの有無を検出して確認ダイアログを出すことがゴール。これが揃うことで[M10-markdown-preview.md](M10-markdown-preview.md)全体のゴールが完成する。

## 依存関係
- 先行: **[M10a](M10a-markdown-format-core.md) 必須**（`memo:convertFormat`・`memo:create`の`format`引数）。
- 先行: **[M10b](M10b-markdown-live-preview.md) 必須**（ソース/プレビュー切替は`markdownDecorations.ts`のライブ描画のON/OFFに依存するため）。
- [M8](M8-node-lock-core.md)/[M9a〜c](M9a-node-lock-session-ops.md)（ノードロック）への依存・被依存は無い。

## このフェーズで扱う型/データ構造（PLANv3 §4）
```ts
const MARKDOWN_IMAGE_SIZE_WARN_BYTES = 500 * 1024; // 目安。DESIGNv3 §2.6「数百KB〜1MB」の下限寄り（developer調整可）
```
（`MARKDOWN_ALLOWED_IMG_ATTRS`/`MARKDOWN_IMAGE_SRC_PATTERN`は[M10b](M10b-markdown-live-preview.md)で定義済みのものをそのまま使用）

## このフェーズで扱う処理フロー（PLANv3 §5.7/§5.8のUI側）

### 画像貼り付けフロー
1. レンダラ: クリップボード/ドロップの画像データを取得→バイト数を計測（貼付け時点で既にメモリ上にあるため追加I/O不要）。
2. `MARKDOWN_IMAGE_SIZE_WARN_BYTES`超なら実サイズ（約◯MB）を明記した確認ダイアログ（既存`ConfirmDialog`）を表示。
3. 続行時、Base64化し`![](data:image/png;base64,...)`をカーソル位置へ挿入（IPC不要、全てレンダラ内完結）。

### `.txt`↔`.md`変換フロー（UI側）
- **`.txt`→`.md`**: ツールバー等のUIから[M10a](M10a-markdown-format-core.md)で実装済みの`memo:convertFormat{targetFormat:'md'}`を呼ぶ。
- **`.md`→`.txt`**: レンダラが現在の本文から装飾タグ(`<span`)/画像データURI(`data:image/`)の有無を正規表現で検出→検出時のみ確認ダイアログ表示（「この操作を行うと、色などの装飾用タグや画像データがそのまま文字として表示されるようになります。続行しますか？」）→続行後に同一の`memo:convertFormat{targetFormat:'txt'}`を呼ぶ（本文無変更、拡張子のみ）。
- 新規メモ作成時に`.md`形式を選択できるUI（既存の新規作成フローに`format`指定を追加、[M10a](M10a-markdown-format-core.md)の`memo:create`の`format`引数を使用）。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/renderer/editor/imagePaste.ts`（新規）— 貼り付け/ドロップ画像→サイズ計測→警告→Base64埋め込みテキスト挿入
- `src/renderer/components/Editor/MarkdownToolbar.tsx`（新規）— ライブプレビュー編集中専用ツールバー（配置・ボタン構成はdeveloper裁量。ソース/プレビュー切替・`.txt`⇔`.md`変換ボタンを含む）
- 既存の新規作成UI（拡張）— `.md`形式選択の追加
- 既存`ConfirmDialog`の利用（変更なし、呼び出し追加のみ）

## このフェーズのエラーハンドリング
新規エラーコードは無し。既存の`NAME_DUPLICATE`/`NAME_INVALID`等をそのまま再利用する（[M10a](M10a-markdown-format-core.md)で実装済みの`memo:convertFormat`のエラーをそのまま表示）。

## DESIGNv3.md の関連セクション
- 目的・編集体験（ライブプレビュー方式、ソース切替）: §2.1。
- 保存形式・拡張子（`.md`新設、変換フロー、変換前警告）: §2.4。
- 既存機能との相互作用（画像サイズ警告）: §2.6。

## PLANv3.md §7 実装補完事項の関連項目
なし（§7.1〜§7.7はすべてノードロック機能に関する項目）。

## reviewer/tester への申し送り
- `.md`→`.txt`変換時、装飾タグ・画像データURIを含む本文で確認ダイアログが正しく出るか（検出しない場合は無警告で変換されるか）を**最重要確認項目**として確認すること。
- ソース/プレビュー切替が正しく[M10b](M10b-markdown-live-preview.md)のライブ描画のON/OFFと連動しているか（切替時に本文が変化しないか）を確認すること。
- 画像貼り付けのサイズ警告閾値（`MARKDOWN_IMAGE_SIZE_WARN_BYTES`）が実際に機能しているか、警告ダイアログのサイズ表示が実際のバイト数と整合しているかを確認すること。
