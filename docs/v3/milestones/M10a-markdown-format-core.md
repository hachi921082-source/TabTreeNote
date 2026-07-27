# M10a — Markdown保存形式基盤・全文検索反映

> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは、当初の [M10-markdown-preview.md](M10-markdown-preview.md)（実行コストが大きいためユーザー判断で3分割）のうち、
> **`.md`拡張子をファイル層・IPC・全文検索が`.txt`と同格に扱えるようにするバックエンド基盤**を扱う。3分割の最初。
> ライブプレビュー描画は[M10b](M10b-markdown-live-preview.md)、ツールバー/画像貼り付け/変換UIは[M10c](M10c-markdown-toolbar-ui.md)で扱う。

## ゴール（PLANv3 §5.8の一部/§5.9/§2.3/§2.5）
`.md`拡張子のメモが`.txt`と同様に作成・読込・保存・リネーム・削除・複製・移動できること、拡張子変換IPC(`memo:convertFormat`)が本文無変更でリネームだけを行うこと、暗号化`.txtenc`が元拡張子から`format`を自動判定して保持・復元できること、全文検索インデックスが`.md`の本文をタグ除去した上で索引化することがゴール。**この時点ではまだ装飾のライブプレビュー描画は行わない**（生のMarkdownテキストがそのままエディタに表示されればよい。装飾描画は[M10b](M10b-markdown-live-preview.md)スコープ）。

## 依存関係
- 先行: v1 **M1**（ファイル層コア）、**M3**（全文検索インデックス）、**M6**（`.txtenc`フォーマット・暗号化変換フロー、`format`フィールドの追加先）。
- [M8](M8-node-lock-core.md)/[M9a〜c](M9a-node-lock-session-ops.md)（ノードロック）への依存・被依存は無い。
- [M10b](M10b-markdown-live-preview.md)/[M10c](M10c-markdown-toolbar-ui.md)は本マイルストーン必須。

## このフェーズで扱う IPC チャネル（PLANv3 §2.3）
| チャネル | 変更内容 |
|----------|----------|
| `memo:create` | 引数に `format?: 'plain' \| 'markdown'`（省略時`'plain'`）を追加。`'markdown'`指定時は拡張子`.md`でファイル作成 |
| `memo:convertFormat`（新規） | `{ tabId, memoName, targetFormat: 'txt' \| 'md', lockContext? }` → `Result<MemoInfo>`。拡張子のみリネーム、本文は無変更（DESIGNv3 §2.4）。**呼び出し元UI（検出・確認ダイアログ）は[M10c](M10c-markdown-toolbar-ui.md)スコープ。本マイルストーンではIPCハンドラ自体のみ実装する** |
| `crypto:encryptMemo` | 引数変更なし。元ファイルの拡張子(`.txt`/`.md`)から`format`を自動判定し`.txtenc`の`format`フィールドへ反映（DESIGNv3 §2.5 Q8） |
| `crypto:decryptMemoToPlain` | 引数変更なし。`.txtenc`の`format`フィールドに従い`.txt`/`.md`いずれかへ復元 |

## このフェーズで扱う型/データ構造（PLANv3 §4）
```ts
// .txtenc フォーマット拡張（確定・DESIGNv3 §2.5 Q8）
interface TxtEncFile {
  // ...既存フィールド（magic/formatVersion/kdf/cipher/eol/hint/ciphertextB64、v1 data-model.md参照）
  format?: 'plain' | 'markdown';  // 省略時 'plain'（後方互換）
}
```

## このフェーズで扱う処理フロー（PLANv3 §5.8の一部/§5.9）

### `.txt`↔`.md`変換フロー（IPCハンドラ部分のみ）
- **`.txt`→`.md`**: `memo:convertFormat{tabId, memoName, targetFormat:'md'}` → 拡張子のみリネーム（本文無変更, DESIGNv3 §2.4）。
- **`.md`→`.txt`**: 同一の`memo:convertFormat{targetFormat:'txt'}`を呼ぶ（本文無変更、拡張子のみ）。**装飾/画像データの検出・確認ダイアログはレンダラ側の責務であり[M10c](M10c-markdown-toolbar-ui.md)スコープ。本マイルストーンのIPCハンドラは無条件でリネームするだけでよい**。
- 暗号化メモの場合は`crypto:encryptMemo`/`crypto:decryptMemoToPlain`実行時に元拡張子(`.txt`/`.md`)から`format`を自動判定し`.txtenc`の`format`フィールドへ反映する（新規IPCパラメータは不要）。

### 全文検索インデックスへのMarkdown反映
`searchIndex.ts`のインデックス構築/差分更新時、`.md`ファイルは本文を許可リストタグ除去（プレーンテキスト化）した上で通常の`.txt`と同様に本文インデックス対象にする（DESIGNv3 §2.6 Q11）。マッチ判定はタグ除去後のプレーンテキスト基準の完全一致とする。ロック中/セッション中の配下は既存ルール通り常に名前ごと除外する（DESIGNv3 §1.7 Q1）。**タグ除去の対象となる許可リスト定数（`MARKDOWN_ALLOWED_TAGS`等）は[M10b](M10b-markdown-live-preview.md)で新設するものと同一の定数を参照する想定だが、循環依存を避けるため本マイルストーンでは`constants.ts`側にタグ除去に必要な最小限の定数（タグ名`span`/`img`の除去用パターン）を先に定義してよい（developer裁量）**。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/main/fs/tabService.ts`（拡張）— `scanTabFolder`が`.md`を`.txt`と並ぶ「平文相当」の第三拡張子として認識
- `src/main/fs/memoFileService.ts`（拡張）— `.md`のread/write/rename/moveを`.txt`と同一ロジックで扱う（拡張子だけ分岐）
- `src/main/ipc/memoHandlers.ts`（拡張）— `convertFormat`ハンドラを追加
- `src/main/ipc/cryptoHandlers.ts`（拡張）— `encryptMemo`/`decryptMemoToPlain`の`format`自動判定・反映ロジック
- `src/main/search/searchIndex.ts`（拡張）— `.md`の本文をタグ除去してから索引化
- `src/shared/constants.ts`（拡張）— タグ除去に必要な最小限の定数（後述、M10bで拡充）

## このフェーズのエラーハンドリング
新規エラーコードは無し。既存の`NAME_DUPLICATE`/`NAME_INVALID`等をそのまま再利用する（`convertFormat`実行時、変換先拡張子で同名ファイルが既に存在する場合は`NAME_DUPLICATE`）。

## DESIGNv3.md の関連セクション
- 保存形式・拡張子（`.md`新設、変換フロー、変換前警告はUI側）: §2.4。
- 暗号化メモとの関係（`format`フィールド）: §2.5。既存機能との相互作用（全文検索）: §2.6 Q11。

## PLANv3.md §7 実装補完事項の関連項目
なし（§7.1〜§7.7はすべてノードロック機能に関する項目）。

## reviewer/tester への申し送り
- `.md`ファイルが`.txt`と全く同様にCRUD（作成/読込/保存/リネーム/削除/複製）・移動できるか（拡張子分岐漏れがないか）を重点確認すること。
- `memo:convertFormat`実行後、メタJSON・全文検索インデックスが正しく追従しているか（旧拡張子のインデックスエントリが残留していないか）を確認すること。
- 暗号化`.md`メモの`format`フィールドが正しく設定され、復号時に`.md`拡張子で復元されるか（`.txt`との取り違えがないか）を確認すること。
- 既存(v1)の`format`フィールドを持たない`.txtenc`ファイルが後方互換で`'plain'`扱いになるか（マイグレーション不要で読めるか）も確認すること。
