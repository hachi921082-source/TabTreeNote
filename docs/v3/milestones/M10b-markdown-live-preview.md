# M10b — Markdown装飾ライブプレビュー描画・サニタイズ

> 派生ドキュメント。正本は [DESIGNv3.md](../DESIGNv3.md)（設計判断）/ [PLANv3.md](../PLANv3.md)（実装計画）。
> v1の横断ルールは [../../00-core-principles.md](../../00-core-principles.md)、v1型は [../../data-model.md](../../data-model.md)。
> 本マイルストーンは、当初の [M10-markdown-preview.md](M10-markdown-preview.md)（実行コストが大きいためユーザー判断で3分割）のうち、
> **文字装飾（色/太字/文字サイズ）のライブプレビュー描画・サニタイズ・右クリック装飾コマンド**を扱う。3分割の2番目。
>
> **2026-07-26追記**: M10a実装完了後、ノードロック（M8/M9a〜c）とMarkdown保存形式の交差ケース（`.md`メモを含むサブツリーを
> ロックするとMarkdown属性`format`が失われ、ロック解除セッション中に開いてもライブプレビュー対象と判定できなくなる問題。
> 調査の過程で見つかった関連ギャップ=`crypto:open`のレスポンスにも`format`が無く暗号化`.md`メモの個別開封時にも同様の問題が
> 起きる点を含む）について、ユーザー判断で「M10b着手前にdesignerが設計する」こととし、designerが設計を確定させた
> （DESIGNv3.md §1.13、PLANv3.md §7.8）。**本マイルストーンには、通常の装飾ライブプレビュー描画実装に加えて、下記
> 「0. 前提: format伝播の実装（ノードロックとの交差対応）」の実装が含まれる。**

## 0. 前提: format伝播の実装（ノードロックとの交差対応、2026-07-26追記・必須先行作業）

以下は本マイルストーンの装飾ライブプレビュー描画（§以降）に着手する前に完了させること。ライブプレビューは「このメモがMarkdown（`.md`由来）かどうか」をレンダラが正しく判定できて初めて意味を持つため、この判定がノードロックのロック解除セッション配下・M6個別暗号化開封時の両方で正しく機能する状態を先に作る。設計判断の理由・代替案の比較はDESIGNv3.md §1.13、実装補完としての位置づけはPLANv3.md §7.8を参照（本節はそれをdeveloperがそのまま実装できる粒度へ落としたもの）。

### 0.1 型変更

- `src/shared/models.ts`
  - `NodeLockBlob`に`formatMap: Record<string, 'plain' | 'markdown'>`を追加（`nameMap`と同じキー集合。起点ノード自身の分も含む）。
  - `TreeNode`に`readonly format?: 'plain' | 'markdown'`を追加。平文メモ・ロック解除セッション配下メンバーには設定するが、通常領域の未開封`.txtenc`ノード・入れ子ロック済み(未解除)プレースホルダは`undefined`のまま（実体はパスワード復号を経ないと分からないため）。
- `src/shared/ipc-contract.ts`
  - `CryptoOpenResult`に`format: 'plain' | 'markdown'`（必須）を追加。
- `src/main/crypto/nodeLockSessionStore.ts`
  - `NodeLockSessionEntry`に`formatMap: Record<string, 'plain' | 'markdown'>`を追加（`nameMap`と対）。

### 0.2 関数変更（`src/main/crypto/nodeLock.ts`）

- `readSubtreeMember`: 戻り値に`format: 'plain' | 'markdown'`を追加（`{contentLF, eol, oldPath, format}`）。
  - `parentEntry`未指定（通常領域から読む）分岐: `findMemoFile`が返す`found.format`をそのまま使う。
  - `parentEntry`指定（親セッション配下から読む、入れ子ロック用）分岐: `parentEntry.formatMap[n.memoName] ?? 'plain'`を使う（個々の`.txtenc`ヘッダの`format`は参照しなくてよい。理由はDESIGNv3 §1.13「伝播の設計」1参照）。
- `lockNode`:
  - サブツリーの各メンバーを読み込むループで`reads`に`format`も保持済み（上記変更で自動的に付いてくる）。
  - `nameMap`を構築するループと同じ箇所で`formatMap: Record<string,string> = {}`も構築し`formatMap[n.memoName] = read.format`する。
  - `buildTxtEncFile()`呼び出しに`format: read.format`を渡す（自己記述性のための多重化。セッション内ロジックは参照しないが書いておく）。
  - `NodeLockBlob`構築箇所に`formatMap`を追加。
  - 入れ子ロック時（`parentEntry && parentLockToken`分岐）、既存の`for (const n of subtree) delete parentEntry.nameMap[n.memoName];`と並べて`delete parentEntry.formatMap[n.memoName];`も行う。
- `unlockNode`: `NodeLockSessionEntry`構築箇所（`entry = {...}`）に`formatMap: blob.formatMap ?? {}`を追加。
- `reencryptSessionBlob`: 構築する`NodeLockBlob`に`formatMap: entry.formatMap`を追加。
- `writeSessionMemoContent`: 引数へ`format: 'plain' | 'markdown'`を追加（必須。呼び出し元が明示的に決定して渡す。内部で`formatMap`を更新する責務は持たせない＝呼び出し元が責務を持つ）。`buildTxtEncFile()`呼び出しに`format`を渡す。

### 0.3 関数変更（`src/main/ipc/memoHandlers.ts`）

- `createMemoInSession`: 引数に`format: 'plain' | 'markdown' | undefined`を追加（呼び出し元の`memo:create`ハンドラから`args.format`を渡す）。`writeSessionMemoContent`呼び出しに`format ?? 'plain'`を渡し、`entry.nameMap[name] = token;`と並べて`entry.formatMap[name] = format ?? 'plain';`も行う。
  - `memo:create`ハンドラの`lockContext`分岐（`createMemoInSession(...)`呼び出し）に`args.format`を追加で渡す。
- `renameMemoInSession`: 既存の`nameMap`キー付け替え（`delete entry.nameMap[oldName]; entry.nameMap[newName] = token;`）と同じ箇所に、`formatMap`も同様にキー付け替えする処理を追加する（起点ノード自身のリネームも同じコードパスを通るため特別扱い不要）。
- `deleteMemosInSession`: `removeNode(entry.children, name); delete entry.nameMap[name];`のループに`delete entry.formatMap[name];`も追加する。
- `duplicateMemoInSession`: `entry.nameMap[newName] = newToken;`と並べて`entry.formatMap[newName] = entry.formatMap[memoName] ?? 'plain';`を追加する。
- `moveWithinSession`（コピー分岐のみ、移動分岐は名前・トークンとも不変のため変更不要）: `entry.nameMap[rename.to] = newToken;`と並べて`entry.formatMap[rename.to] = entry.formatMap[rename.from] ?? 'plain';`を追加する。
- `moveIntoSession`: `readSubtreeMember`が返す`read.format`を使い、`writeSessionMemoContent`呼び出しへ渡す。`destEntry.nameMap[renameOf(n.memoName)] = token;`と並べて`destEntry.formatMap[renameOf(n.memoName)] = read.format;`も追加する。
- `memo:save`ハンドラの`lockContext`分岐: `writeSessionMemoContent`呼び出しに`entry.formatMap[args.memoName] ?? 'plain'`を渡す（内容だけの保存なので既存値をそのまま使い、変更しない）。
- `memo:read`ハンドラの`lockContext`分岐: 戻り値の`MemoReadResult`自体は変更不要（`format`はTreeNode経由でレンダラに伝わる既存ツリー状態から分かるため。0.1のTreeNode.format参照）。

### 0.4 関数変更（`src/main/crypto/nodeLockSessionStore.ts`）

- `buildSessionTreeNodes(children, lockToken)` → `buildSessionTreeNodes(children, lockToken, formatMap: Readonly<Record<string, string>>)`にシグネチャ変更。非ロックノードの返却オブジェクトに`format: formatMap[n.memoName] === 'markdown' ? 'markdown' : 'plain'`を追加する（入れ子ロック済みプレースホルダには追加しない＝`undefined`のまま）。
- `buildOriginTreeNode(entry, lockToken)`: 返却オブジェクトに`format: entry.formatMap[entry.realMemoName] === 'markdown' ? 'markdown' : 'plain'`を追加し、`buildSessionTreeNodes`呼び出しに`entry.formatMap`を渡す。

### 0.5 関数変更（`src/main/fs/metaStore.ts`）

- `reconcile`内、非ロック・非入れ子の通常ノード構築箇所（`scannedEntry`が見つかった分岐）: `format: scannedEntry.encrypted ? undefined : (scannedEntry.format === 'markdown' ? 'markdown' : 'plain')`を追加する（暗号化済みノードは`ScannedMemo.format`が実体を反映しない便宜上のプレースホルダ`'plain'`のため、`undefined`のままにする。理由はDESIGNv3 §1.13「伝播の設計」2参照）。
- 実体はあるがメタに無い「孤児」ノードのフラット追加箇所（`extras`）にも同様に`format`を設定する（同じ条件分岐）。

### 0.6 関数変更（`src/main/ipc/cryptoHandlers.ts`）

- `crypto:open`ハンドラ: 戻り値`ok<CryptoOpenResult>({...})`に`format: loaded.file.format === 'markdown' ? 'markdown' : 'plain'`を追加する（`setSessionKey`へ渡している値と同じ判定ロジックを再利用してよい）。

### 0.7 レンダラ側の判定方針（実装詳細はdeveloper裁量）

現在開いているメモがライブプレビュー対象（Markdown）かどうかは、次のいずれかで判定する:
- 平文メモ、およびロック解除セッション配下メモ: 現在のツリー状態（`TreeSnapshot`/`CryptoUnlockNodeResult.tree`由来）から対象`memoName`（セッション配下なら`lockContext`と組み合わせ）の`TreeNode.format`を参照する（既存の`editor`/`label`と同じ「ツリー状態から都度引く」パターンを踏襲してよい）。
- M6個別暗号化を`crypto:open`で開封したメモ: `crypto:open`のレスポンス`format`を、そのメモを開いている間のローカル状態として保持する（`TreeNode.format`は該当ノードが`encrypted:true`の間`undefined`のままのため、開封後はこちらを使う）。

### 0.8 対象外（変更しない）

- `memo:convertFormat`の`lockContext`指定時の拒否（`NAME_INVALID`）は変更しない。セッション配下の拡張子変換UIはM10cスコープの判断待ち（PLANv3 §7.8参照）。

## ゴール（PLANv3 §5.6/§2.3）
右クリックメニューから文字色/太字/文字サイズを選択して選択範囲を装飾でき、CodeMirrorの`ViewPlugin`が文書変更を検知して許可リストでサニタイズした見た目をライブ描画すること。実データは常にMarkdownテキスト（`<span style="...">`タグ込みのプレーンテキスト）のままであり、装飾はあくまで見た目の変換であることがゴール。`<script>`/`on*`イベント属性/`javascript:`スキーム/許可外CSSプロパティは黙って除去される（セキュリティ不変条件）。**ツールバーからの操作・ソース/プレビュー切替・画像貼り付けは[M10c](M10c-markdown-toolbar-ui.md)スコープ**（本マイルストーンは右クリックメニュー経由の装飾操作とライブ描画そのものが対象）。

## 依存関係
- 先行: **[M10a](M10a-markdown-format-core.md) 必須**（`.md`ファイルの作成・読込・保存ができる状態が前提。`.md`拡張子が認識されないとエディタで開けない）。
- v1 **M1**（CodeMirror 6統合、`textCommands.ts`の`changeByRange`パターン）。
- [M8](M8-node-lock-core.md)/[M9a〜c](M9a-node-lock-session-ops.md)（ノードロック）への依存・被依存は無い。
- [M10c](M10c-markdown-toolbar-ui.md)は本マイルストーン必須（ソース/プレビュー切替は本マイルストーンで実装するデコレーション描画のON/OFFに依存するため）。

## このフェーズで扱う型/データ構造（PLANv3 §4）
```ts
// Markdown サニタイズ許可リスト（確定・DESIGNv3 §2.3）
const MARKDOWN_ALLOWED_TAGS = ['span', 'img'] as const;
const MARKDOWN_ALLOWED_SPAN_STYLE_PROPS = ['color', 'font-size', 'font-weight'] as const;
const MARKDOWN_ALLOWED_IMG_ATTRS = ['src', 'width', 'height'] as const;
const MARKDOWN_IMAGE_SRC_PATTERN = /^data:image\/(png|jpe?g|gif|webp);base64,/;
```
`img`関連の許可リスト（`MARKDOWN_ALLOWED_IMG_ATTRS`/`MARKDOWN_IMAGE_SRC_PATTERN`）は[M10c](M10c-markdown-toolbar-ui.md)の画像貼り付け機能で使われるが、サニタイズ処理自体（`markdownSanitize.ts`）は本マイルストーンで実装するため、定数は本マイルストーンでまとめて定義してよい（[M10a](M10a-markdown-format-core.md)で先行定義した最小限のタグ除去用定数がある場合は整合を取ること）。

**サニタイズ実装上の注意**: `DOMPurify`を使う場合、`ALLOWED_TAGS`/`ALLOWED_ATTR`で`span`/`img`とその属性は絞れるが、`style`属性の**CSSプロパティ単位**の絞り込み（`color`/`font-size`/`font-weight`のみ許可、`position`/`opacity`等は除去）は標準機能だけでは足りないため、`uponSanitizeAttribute`フックで追加実装が必要（PLANv3 §0）。

## このフェーズで扱う処理フロー（PLANv3 §5.6）

### Markdown装飾コマンド実行フロー
1. レンダラ: 右クリックメニュー「文字色/太字/文字サイズ」選択→対応コマンドを`changeByRange`で実行し、選択範囲を`<span style="...">...</span>`でラップ/アンラップ（既存`textCommands.ts`と同パターン、Undo単位も同様に1トランザクション=1Undo, DESIGNv3 §2.2）。
2. CodeMirrorの`ViewPlugin`（`markdownDecorations.ts`）が文書変更を検知し、`markdownSanitize.ts`の許可リストでサニタイズしたHTMLを見た目として描画する（実データは常にMarkdownテキストのまま）。
3. 保存は既存`memo:save`/`crypto:saveEncrypted`をそのまま使用（追加IPC不要）。

## このフェーズで扱うディレクトリ/ファイル（PLANv3 §3）
- `src/renderer/editor/markdownSanitize.ts`（新規）— DOMPurify設定 + 許可リスト定数 + style属性のプロパティ単位フィルタ
- `src/renderer/editor/markdownDecorations.ts`（新規）— CodeMirror ViewPlugin、ライブプレビュー描画
- `src/renderer/editor/decorationCommands.ts`（新規）— 文字色/太字/文字サイズの`changeByRange`コマンド
- `src/shared/constants.ts`（拡張）— `MARKDOWN_ALLOWED_*`定数群
- 既存の右クリックメニューコンポーネント（拡張）— 「文字色/太字/文字サイズ」項目を`.md`メモ編集時のみ追加

## このフェーズのエラーハンドリング
新規エラーコードは無し。サニタイズで許可リスト外のタグ・属性・CSSプロパティ（`<script>`・`on*`イベント属性・`javascript:`スキーム等を含む）を検出した場合は例外を出さず**黙って除去**する（プレビュー描画時に必ず除去することがセキュリティ不変条件, DESIGNv3 §2.3）。

## DESIGNv3.md の関連セクション
- 目的・編集体験（ライブプレビュー方式）: §2.1。装飾操作・Undo粒度: §2.2。
- 安全性（許可リスト方式、styleプロパティ単位の絞り込み）: §2.3。
- 許可するMarkdown記法の範囲（装飾のみ、構造記法は対象外）: §2.7。

## PLANv3.md §7 実装補完事項の関連項目
**§7.8（2026-07-26追記）が本マイルストーンに直接関係する**（ノードロック×Markdown保存形式の交差ケースにおける`format`伝播。上記「0. 前提」参照）。§7.1〜§7.7はノードロック機能単体に関する項目のため本マイルストーンとは無関係。

## reviewer/tester への申し送り
- サニタイズが本当に許可リスト外を除去できているか（`<script>`/`on*`イベント属性/`javascript:`スキーム/許可外CSSプロパティ）を**最重要確認項目**とすること。装飾はあくまで見た目の変換であり、実行可能なコードを本文から生成させないことがセキュリティ不変条件。
- 装飾コマンド実行後、本文（保存されるMarkdownテキスト）が`<span style="...">`タグを含む想定通りの形になっているか（見た目とデータの分離が保たれているか）を確認すること。
- Undo単位が1トランザクション=1Undoになっているか（既存`textCommands.ts`との整合）を確認すること。
- **【0節・ノードロック交差対応、2026-07-26追記】** 以下をtester実UI検証の重点確認項目とすること:
  - `.md`メモを含むサブツリーをロック→解除→再度ロック→再度解除、を1往復以上させた後も、当該メモがライブプレビュー対象（Markdown）のまま維持されるか（`formatMap`のブロブ往復）。
  - ロック解除セッション中に新規`.md`メモを作成した場合、そのメモがセッション内で（保存・別メモ表示→再表示を挟んでも）ライブプレビュー対象のまま維持されるか。
  - 通常領域の`.md`メモをドラッグ&ドロップでロック解除セッション配下へ「外→内」移動した場合（DESIGNv3 §1.12）、移動後もMarkdown属性が維持されるか。
  - リネーム・複製（セッション内）後もMarkdown属性が維持されるか。
  - 暗号化された`.md`メモを`crypto:open`で個別開封した場合（ノードロックとは無関係な既存M6経路）にもライブプレビューが効くか。
  - 通常領域の`.txt`メモ（Markdownでない）が誤ってMarkdown扱いされていないか（`format`の取り違えが逆方向に起きていないかの確認）。
