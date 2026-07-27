# TabTreeNote v3 実装計画 (PLANv3.md)

> 本ドキュメントは、確定済みの [DESIGNv3.md](DESIGNv3.md)（①ノード単位パスワードロック、②Markdown＋ライブプレビュー）を土台に、
> developer がそのまま実装に着手できる粒度へ落とし込んだ**実装計画**である。PLAN.md/DESIGN.md（v1正本）との関係と同じく、
> DESIGNv3.md に記載された確定済みの設計判断・トレードオフを変更・再解釈するものではない。両者に齟齬が生じた場合、
> 設計判断の正本は DESIGNv3.md、実装計画の初版は本 PLANv3.md とする。
>
> **v1（PLAN.md/DESIGN.md）への影響**: v1スコープの正本・実装は変更しない。本ドキュメントはv3の2機能に限定した追加分のみを記す。
> 既存の `docs/00-core-principles.md`（Result型規約・アトミック書き込み・同期順序・自己書き込み予約・競合判定2系統・名前サニタイズ等）は
> そのまま踏襲し、本ドキュメントでは再掲しない。
>
> **本ドキュメントの範囲**: マイルストーン分割（PLAN.md §7 相当）は含めない。ユーザー指示により「まず実装計画書の作成」→
> 「その後マイルストーン分割」の2段階で進めるため、本ドキュメントは §0〜§7（PLAN.md の §0〜§6・§8 相当）のみを扱う。
>
> **本PLANv3で見つかった最重要の実装補完**: DESIGNv3.mdには明記が無いが、DESIGNv3 §1.2の確定要件（ロック中は🔒以外の情報を一切見せない）を実際に満たすには実装上必須な要素として、
> ロック中ノードの子孫ファイルをツリーの孤児判定から除外するための `claimedTokens`（§4/§7.1）を追加している。これが無いと、ロックで隠したはずの子孫ファイルが
> 孤児ノードとしてツリーに露出してしまう（設計方針の変更ではなく、既存確定要件を実現するための実装補完）。詳細は §7.1。

---

## 0. 前提

- 技術スタックの新規選定は無し。v1既定（Electron+TS+React+CodeMirror6+electron-vite、PLAN.md §0）をそのまま流用する。
- **新規追加ライブラリ候補**: Markdown機能のサニタイズに `DOMPurify` を採用する（DESIGNv3 §2.3 で想定されているライブラリ）。`ALLOWED_TAGS`/`ALLOWED_ATTR` に加え、`style` 属性はCSSプロパティ単位で絞り込む必要があるため `uponSanitizeAttribute` フックで `color`/`font-size`/`font-weight` 以外のプロパティを除去する追加実装が要る（DOMPurify標準機能だけでは属性単位までしか絞れないため）。
- ノードロックの難読化ファイル名生成・ブロブ暗号化は、いずれもM6暗号化(`src/main/crypto/cipher.ts`)の既存プリミティブ（`crypto.scrypt`非同期呼び出し、AES-256-GCM）をそのまま再利用する。新規の暗号ライブラリは不要。

---

## 1. アーキテクチャ構成（責務分担の追加分）

### 1.1 メインプロセスの追加責務
- **ノードロック**: ロック/ロック解除/再ロックのオーケストレーション、ブロブの暗号化/復号、難読化ファイル名の採番+衝突時再生成、ロック解除セッション中の実名↔難読化名解決（既存`memo:*`/`tree:updateStructure`ハンドラの拡張、§2.2参照）。
- **Markdown**: メインプロセス側の変更は小さい。`.md`をファイル走査(`tabService.scanTabFolder`)で`.txt`と並ぶ「平文相当」の第三の拡張子として認識させる、`.txtenc`の`format`フィールド読み書き、全文検索インデックス構築時に`.md`の本文をタグ除去してから索引化、の3点のみ。装飾・サニタイズ・プレビュー描画・画像Base64埋め込みはすべてレンダラ側で完結する。

### 1.2 preload
- ノードロック用に `lockNode`/`unlockNode`/`relockNode`/`relockAllInTab` を `window.api` へ追加公開する。
- Markdown機能は新規IPC露出が実質不要（既存`memo:*`の拡張引数を渡すラッパーの更新のみ）。

### 1.3 レンダラの追加責務
- **ノードロック**: ツリー右クリックメニューへ「サブツリーをロック」「ロックを解除」を追加（既存M6暗号化ダイアログの見た目・確認再入力ルールを流用, DESIGNv3 §1.11）。ロック中ノードは`TreeNode.locked===true`を見て常に「🔒(ロック中)」表示・`children`を空扱いで描画。ロック解除セッション配下は`TreeNode.lockToken`を保持し、以後そのサブツリーに対する`memo:*`/`tree:updateStructure`呼び出しには必ず`lockContext:{tabId, lockToken}`を付与する。ドラッグ&ドロップは「セッション配下→外」のドロップをUI側で事前に拒否（§5.4）。
- **Markdown**: CodeMirrorのデコレーション拡張（許可リストタグをその場で見た目反映するライブプレビュー）、右クリック装飾コマンド、専用ツールバー、ソース/プレビュー切替、貼り付け画像のサイズ計測+警告、`.txt`⇔`.md`変換コマンド（変換前の装飾/画像検出+確認ダイアログ）。

### 1.4 ロックセッションの識別子
ロック解除セッションは `(tabId, lockToken)` をキーに `nodeLockSessionStore`（メインプロセスのメモリのみ、既存`sessionKeyStore`と対称の設計）で管理する。`lockToken` は**起点ノード自身の難読化ファイル名**をそのまま用いる（起点ノードの`memoName`自体が難読化トークンであり、セッション中も不変, DESIGNv3 §1.5）。

**`lockContext`（§2.2）は、この`lockToken`をIPC境界を越えて受け渡すための唯一の手段であり、本ドキュメントのIPC拡張・処理フロー全体（§2.2/§5.3/§5.4）を貫く共通キーである。** ロック解除セッション配下に対する`memo:*`/`tree:updateStructure`/`memo:move`の呼び出しは、例外なくこの`lockContext`を介してセッションを解決する。

---

## 2. IPCチャネル設計（追加・拡張分）

方式・`Result<T>`規約は既存（PLAN.md §2/`docs/00-core-principles.md`）をそのまま踏襲。

### 2.1 ノードロック（新規チャネル）
| チャネル | 引数 | 返却 | 説明 |
|----------|------|------|------|
| `crypto:lockNode` | `{ tabId, memoName, password, hint?, lockContext? }` | `Result<void>` | 対象ノード(現在の可視ツリー上の`memoName`。既に別ロックの解除セッション内にある場合は`lockContext`を併記=入れ子ロック)を起点にサブツリーをロックする。個別暗号化(`.txtenc`)が対象配下に混在する場合は`LOCK_CONTAINS_ENCRYPTED`（DESIGNv3 §1.10）。処理内容は §5.1 |
| `crypto:unlockNode` | `{ tabId, memoName, password, lockContext? }` | `Result<{ lockToken: string; tree: TreeNode[] }>` | ロック中ノード(`memoName`は難読化トークン)をパスワードで復号しセッション開始。誤りは既存`DECRYPT_FAILED`を再利用。処理内容は §5.2 |
| `crypto:relockNode` | `{ tabId, lockToken }` | `Result<void>` | 単一セッションの明示的破棄（メモリ上の対応表・復号済み構造を破棄するのみ。ファイル操作なし, DESIGNv3 §1.5） |
| `crypto:relockAllInTab` | `{ tabId }` | `Result<void>` | 指定タブに紐づく**全**ロックセッションを一括破棄（タブ切替時用、§5.5）。DESIGNv3 §1.11が要求する「タブ離脱時の即時セッション破棄」を満たすための実装用IPC（一括化という実装方式自体の是非はPLANv3判断、§7.6） |

### 2.2 既存メモ/ツリー操作の拡張（ロックセッション対応）
`memo:read` / `memo:save` / `memo:create` / `memo:rename` / `memo:delete` / `memo:duplicate` / `memo:move` / `tree:updateStructure` に、共通の任意引数 `lockContext?: { lockToken: string }` を追加する（新規チャネルは作らず既存を拡張する。DESIGNv3全体の「既存機構の自然な延長」方針に合わせる）。

- **`lockContext` 省略時**: 既存v1と完全に同じ挙動（タブ直下の可視ツリー・実ファイルが対象）。
- **`lockContext` 指定時**: 対象タブの該当ロックセッション（`nodeLockSessionStore`）が保持する実行時構造・`nameMap`を介して`memoName`を解決する。ファイル操作は難読化ファイル名に対して行い、構造変更操作の**都度**、セッション鍵でブロブを再暗号化しメタJSONへアトミック保存する（DESIGNv3 §1.5、詳細は §5.3）。
- **`memo:move` のみ境界跨ぎの特別ルールを追加**（`srcLockContext`/`destLockContext`、§5.4参照）。

### 2.3 Markdown（既存チャネルの拡張のみ、新規チャネル最小限）
| チャネル | 変更内容 |
|----------|----------|
| `memo:create` | 引数に `format?: 'plain' \| 'markdown'`（省略時`'plain'`）を追加。`'markdown'`指定時は拡張子`.md`でファイル作成 |
| `memo:convertFormat`（新規） | `{ tabId, memoName, targetFormat: 'txt' \| 'md', lockContext? }` → `Result<MemoInfo>`。拡張子のみリネーム、本文は無変更（DESIGNv3 §2.4）。`.md`→`.txt`時の装飾/画像検出・確認ダイアログはレンダラ側で本IPC呼び出し前に完結させる（§5.8） |
| `crypto:encryptMemo` | 引数変更なし。元ファイルの拡張子(`.txt`/`.md`)から`format`を自動判定し`.txtenc`の`format`フィールドへ反映（DESIGNv3 §2.5 Q8） |
| `crypto:decryptMemoToPlain` | 引数変更なし。`.txtenc`の`format`フィールドに従い`.txt`/`.md`いずれかへ復元 |
| `crypto:open` | 【2026-07-26追記・§7.8】返却型`CryptoOpenResult`に`format: 'plain' \| 'markdown'`を追加。値は`sessionKeyStore`が既に保持している`.txtenc`ヘッダ由来の判定をそのまま転記する（引数は変更なし） |
| `crypto:unlockNode` | 【2026-07-26追記・§7.8】返却型`CryptoUnlockNodeResult.tree`（`TreeNode[]`）の各要素が新設`TreeNode.format`を持つようになる（§4参照。IPCの引数・チャネル自体に変更はなく、`TreeNode`型拡張の帰結） |

装飾操作・プレビュー描画・画像Base64埋め込み・変換前の警告判定はすべてレンダラ内完結のためIPC不要。

---

## 3. ディレクトリ・ファイル構成（追加分）

PLAN.md §3 のレイアウトに対する追加のみを記す。

```
src/
├─ main/
│  ├─ crypto/
│  │  ├─ nodeLock.ts             # 新規: lockNode/unlockNode/relockNode/relockAllInTabのオーケストレーション、
│  │  │                          #       NodeLockBlobの構築/パース（既存cipher.tsの鍵導出・AES-GCM関数を呼ぶ）
│  │  ├─ nodeLockSessionStore.ts # 新規: (tabId, lockToken) キーでセッション(鍵・nameMap・復号済みchildren)をメモリ保持
│  │  └─ obfuscatedNaming.ts     # 新規: crypto.randomBytes(16).toString('hex') 生成 + 同一フォルダ内衝突時の再生成
│  ├─ fs/
│  │  ├─ tabService.ts           # 拡張: scanTabFolderが .md を平文相当の第三拡張子として認識。
│  │  │                          #       孤児ファイル判定時、各ロックノードの lock.claimedTokens に含まれる
│  │  │                          #       難読化ファイル名は「メタ対応の無い実ファイル」として扱わない（§7.1、必須の実装補完）
│  │  └─ memoFileService.ts      # 拡張: .md のread/write/rename/moveを.txtと同一ロジックで扱う（拡張子だけ分岐）
│  ├─ ipc/
│  │  ├─ cryptoHandlers.ts       # 拡張: lockNode/unlockNode/relockNode/relockAllInTab を追加登録
│  │  └─ memoHandlers.ts         # 拡張: 各ハンドラで lockContext の有無により解決先(通常ツリー/ロックセッション)を分岐、
│  │                              #       convertFormat ハンドラを追加
│  └─ search/
│     └─ searchIndex.ts          # 拡張: .md の本文はタグ除去（プレーンテキスト化）してから索引化（DESIGNv3 §2.6 Q11）。
│                                  #       ロック中/セッション中の配下は名前ごと除外を維持（既存ロジックの延長）
├─ renderer/
│  ├─ editor/
│  │  ├─ markdownSanitize.ts     # 新規: DOMPurify設定 + 許可リスト定数（§4のALLOWED_*）+ style属性のプロパティ単位フィルタ
│  │  ├─ markdownDecorations.ts  # 新規: CodeMirror ViewPlugin。サニタイズ済み許可タグをその場の見た目として描画（ライブプレビュー）
│  │  ├─ decorationCommands.ts   # 新規: 文字色/太字/文字サイズの changeByRange コマンド（textCommands.tsと同パターン, DESIGNv3 §2.2）
│  │  └─ imagePaste.ts           # 新規: 貼り付け/ドロップ画像→サイズ計測→警告→Base64埋め込みテキスト挿入
│  └─ components/
│     ├─ Editor/
│     │  └─ MarkdownToolbar.tsx  # 新規: ライブプレビュー編集中専用ツールバー（配置・ボタン構成はdeveloper裁量, DESIGNv3 §2.2）
│     └─ Tree/
│        └─ TreeRow.tsx          # 拡張: lock有りノードは常に「🔒(ロック中)」表示。lockToken配下ノードは
│                                  #       ドラッグアウト（セッション外への移動先候補としてのドロップ）を拒否
└─ shared/
   ├─ models.ts                  # 拡張: NodeLock/NodeLockBlob/TreeNode.locked/lockToken/TxtEncFile.format（§4）
   ├─ ipc-contract.ts             # 拡張: §2 の新規/拡張チャネル型
   └─ constants.ts                # 拡張: MARKDOWN_ALLOWED_* 定数群（§4）
```

---

## 4. データモデル拡張（確定版）

DESIGNv3.md §4 のスケッチを土台に、developer がそのまま使える形へ確定する。

```ts
// ノードロック（確定版。DESIGNv3 §4スケッチの nameMap 欠落を補い、claimedTokens を追加）
interface NodeLock {
  kdf: { algo: 'scrypt'; N: number; r: number; p: number; keyLen: number };
  saltB64: string;
  ivB64: string;
  tagB64: string;
  hint?: string;
  blobCiphertextB64: string;   // 復号後: NodeLockBlob（JSON）
  claimedTokens: string[];     // 【実装補完・必須】このロックが占有する難読化ファイル名(起点ノード自身を含む)の平文一覧。
                                //   tabService の実ファイル/メタ突合ロジックが「メタ対応の無い実ファイル」を孤児として
                                //   ツリーへフラット追加(=存在の露出)してしまうのを防ぐために必要（§7.1参照）。
                                //   ランダムHEX文字列の羅列のみで名前・階層情報は一切含まない
                                //   （DESIGNv3 §1.9 で許容済みの残存リスク「無作為名ファイルの個数は数えられる」と同水準）。
}

// ブロブ復号後の中身（DESIGNv3 §1.3で言及、型としては本ドキュメントで新規定義）
interface NodeLockBlob {
  realMemoName: string;            // ロック起点ノード自身の元の表示名。起点ノード自身はこのフィールドで表現され、children には含まれない。
  children: MetaTreeNode[];        // 配下の「子」ノードのみ（起点ノード自身は含まない）。内部は平文表現でよい（ブロブ自体が暗号化されているため, §1.3）。
                                    // children の要素が自身の lock を持つこと（入れ子ロック）も型上そのまま許容される（§7.4）
  nameMap: Record<string, string>; // realName -> obfuscatedFileName（起点ノード自身の分も含む）
  formatMap: Record<string, 'plain' | 'markdown'>;
                                    // 【2026-07-26追記・実装補完・§7.8】realName -> format（nameMap と同じキー集合、起点ノード
                                    // 自身の分も含む）。DESIGNv3/PLANv3当初は「ノードロックとMarkdownは独立機能」としており
                                    // 本フィールドの記載が無かったが、M10a実装完了後に「.mdメモを含むサブツリーをロックすると
                                    // markdown属性が失われる」ギャップが判明したため追加した（DESIGNv3 §1.13）。
                                    // 本フィールドが無い（本変更前の）既存ブロブは {} 扱い、未登録キーは 'plain' 扱いにフォール
                                    // バックする（後方互換、TxtEncFile.format 省略時の既定と同じ扱い）。
}

// 【2026-07-26追記・実装補完・§7.8】メインプロセス内専用（IPC境界を越えない）。
// `nodeLockSessionStore.ts` の NodeLockSessionEntry は上記 NodeLockBlob と同じ形の
// formatMap: Record<string, 'plain' | 'markdown'> を持つ（nameMap と対になる、DESIGNv3 §1.13）。
// unlockNode 時に NodeLockBlob.formatMap から復元し、セッション中の構造変更（作成/リネーム/削除/
// 複製/「外→内」移動）のたびに nameMap と同じライフサイクルで追随させる。内容のみの保存
// （memo:save の lockContext 分岐）はこの値を変更せず参照するだけでよい（sessionKeyStore.format
// と同じ「開封/生成時に一度だけ決定し、以後はメモリの値を使い回す」パターン）。

interface MetaTreeNode {
  memoName: string;
  expanded: boolean;
  label?: Label;
  editor?: MemoEditorSettings;
  children: MetaTreeNode[];
  lock?: NodeLock;   // 存在する場合「ロック中」。children は常に []
}

// 実行時ツリー（tab:openTree 等の返却。DESIGNv3にはロック関連フィールドの記載が無かったため本PLANv3で追加）
interface TreeNode {
  readonly memoName: string;
  readonly encrypted: boolean;
  readonly expanded: boolean;
  readonly label?: Label;
  readonly editor?: MemoEditorSettings;
  readonly children: readonly TreeNode[];
  readonly locked?: true;        // true: ロック中(セッション無し)の起点ノード。UIは常に「🔒(ロック中)」表示、children は空
  readonly lockToken?: string;   // ロック解除セッション配下（起点＋子孫全て）に付与。crypto:unlockNode が返した lockToken と同一値。
                                  // このノードに対する memo:*/tree:updateStructure 呼び出しは lockContext:{lockToken} を必須で付ける
  readonly format?: 'plain' | 'markdown';
                                  // 【2026-07-26追記・実装補完・§7.8、DESIGNv3 §1.13】M10bのライブプレビュー判定用。
                                  // 平文メモ: metaStore.reconcile が ScannedMemo.format から設定。
                                  // ロック解除セッション配下: buildOriginTreeNode/buildSessionTreeNodes が formatMap(上記)から設定。
                                  // 通常領域の未開封 .txtenc、および入れ子ロック済み(未解除)プレースホルダは常に undefined
                                  // （実体の format はパスワード復号を経て初めて判明するため、走査だけでは分からない。
                                  //   ScannedMemo が暗号化ファイルに返す 'plain' は実体を反映しない便宜上のプレースホルダ値であり
                                  //   誤って転記しないよう明示的に「不明」として扱う）。
}

// .txtenc フォーマット拡張（確定・DESIGNv3 §2.5 Q8）
interface TxtEncFile {
  magic: string;
  formatVersion: number;
  kdf: { algo: 'scrypt'; N: number; r: number; p: number; keyLen: number; saltB64: string };
  cipher: { algo: 'aes-256-gcm'; ivB64: string; tagB64: string };
  eol: Eol;
  hint?: string;
  ciphertextB64: string;
  format?: 'plain' | 'markdown';  // 省略時 'plain'（後方互換）
}

// crypto:open の返却型（v1/M6の既存チャネル。DESIGNv3 §1.13/§2.5・実装補完§7.8で format を追加）
interface CryptoOpenResult {
  contentLF: string;
  eol: Eol;
  hash: string;
  format: 'plain' | 'markdown';   // sessionKeyStore.format（既にメイン側では保持済みだった値）をそのまま転記する
}

// エラーコード追加分（既存 ErrorCode Union へ追加）
type NodeLockErrorCode =
  | 'LOCK_CONTAINS_ENCRYPTED'  // ロック対象/移動元に既存M6個別暗号化メモが混在（DESIGNv3 §1.10/§1.12）
  | 'LOCK_BOUNDARY_VIOLATION'  // ロック解除中配下→外、または別ロックへの移動・コピー試行（DESIGNv3 §1.12、§7-5）
  | 'LOCK_SESSION_NOT_FOUND';  // lockContext で指定されたセッションが存在しない/失効済み

// Markdown サニタイズ許可リスト（確定・DESIGNv3 §2.3）
const MARKDOWN_ALLOWED_TAGS = ['span', 'img'] as const;
const MARKDOWN_ALLOWED_SPAN_STYLE_PROPS = ['color', 'font-size', 'font-weight'] as const;
const MARKDOWN_ALLOWED_IMG_ATTRS = ['src', 'width', 'height'] as const;
const MARKDOWN_IMAGE_SRC_PATTERN = /^data:image\/(png|jpe?g|gif|webp);base64,/;
const MARKDOWN_IMAGE_SIZE_WARN_BYTES = 500 * 1024; // 目安。DESIGNv3 §2.6「数百KB〜1MB」の下限寄りをPLANv3既定とする（developer調整可）
```

---

## 5. 主要処理フロー

各フローは既存の同期順序原則（`docs/00-core-principles.md` §3: ストア更新→実ファイル操作→直後にメタJSONアトミック保存）をそのまま踏襲する。

### 5.1 ロック実行フロー（`crypto:lockNode`）
1. 対象ノード配下（起点+子孫）を実行時ツリーから収集。いずれかが既存`.txtenc`(個別暗号化)なら`LOCK_CONTAINS_ENCRYPTED`で中断（DESIGNv3 §1.10）。
2. パスワードから新規salt+非同期`crypto.scrypt`で鍵導出（既存`cipher.ts`の導出関数を再利用）。
3. 起点+子孫それぞれについて`obfuscatedNaming.generate()`（16byte hex、同一フォルダ内衝突時は再生成）で新規ファイル名を採番。
4. 各ファイルを`.txtenc`化（平文なら暗号化）した上で難読化名で書き込む。**新ファイル永続化(fsync)確認後に旧ファイルを削除**する順序（M6暗号化変換フロー、PLAN.md §5.4と同じ順序）。`selfWriteRegistry`へ両パスを登録。この時点で各メンバーの元`format`（通常領域からのロックなら`findMemoFile`の走査結果、入れ子ロックなら親セッションの`formatMap`）を確定し`formatMap`へ記録する（§7.8、DESIGNv3 §1.13）。
5. `NodeLockBlob{ realMemoName, children, nameMap, formatMap }`をJSON化→鍵で暗号化(新IV)→Base64化。
6. 起点ノードのMetaTreeNodeを`{ memoName: <起点の難読化名>, expanded:false, children:[], lock:{ kdf, saltB64, ivB64, tagB64, hint, blobCiphertextB64, claimedTokens:[起点+子孫全ての難読化名] } }`へ差し替える。
7. メタJSONをアトミック保存。
8. 全文検索インデックスから該当配下の名前を除去（DESIGNv3 §1.7 Q1。本文は元々`.txtenc`化で既に除外対象）。

### 5.2 ロック解除フロー（`crypto:unlockNode`）
1. 対象`MetaTreeNode.lock`を読み、salt+KDFパラメータで鍵導出。
2. `blobCiphertextB64`をIV+tagで復号。認証タグ検証失敗時は既存`DECRYPT_FAILED`（本文含め一切返さない）。
3. 復号結果`NodeLockBlob`をパースし、`nodeLockSessionStore`へ`(tabId, lockToken=起点の難読化名)`キーで`{ key, nameMap, formatMap, tree: children }`を保持（`formatMap`は§7.8、DESIGNv3 §1.13。ブロブに無ければ`{}`）。
4. `realMemoName`と`children`から実行時`TreeNode[]`を構築（各ノードに`lockToken`と、`formatMap`由来の`format`を付与。`encrypted`は実ファイル拡張子から導出=常に`true`）して返却。

### 5.3 セッション中の構造変更フロー（`lockContext`指定時の`memo:*`/`tree:updateStructure`共通処理）
1. 対象セッションを`nodeLockSessionStore`から取得。無ければ`LOCK_SESSION_NOT_FOUND`。
2. セッションが保持する実行時構造上でオペレーションを実施する:
   - 新規作成: 新規難読化名を採番し`claimedTokens`へ追加、`nameMap`へ登録。**`formatMap`にも`memo:create`の`format`引数（省略時`'plain'`）を登録する**（§7.8）。
   - 削除: 実ファイル削除+`claimedTokens`/`nameMap`から除去。**`formatMap`からも同じキーを除去する**（§7.8）。
   - リネーム: `nameMap`のキー（realName側）のみ差し替え。難読化ファイル名は不変。**`formatMap`のキーも同様に付け替える**（§7.8）。
   - 複製: 複製先を`nameMap`へ登録する際、**`formatMap`にも複製元と同じ値をコピーする**（§7.8）。
   - 起点ノード自身のリネーム: `NodeLockBlob.realMemoName`を更新（DESIGNv3 §1.5「起点ノード自身のリネーム」）。realName側のキー付け替えは上記リネームと同じ処理を通る。
   - 内容のみの保存（`memo:save`）: `formatMap`は変更せず、既存の値を読んで`.txtenc`書き込みへそのまま渡す（§7.8）。
3. 実ファイル操作は難読化ファイル名に対して行う（既存の同期順序・`selfWriteRegistry`登録を踏襲）。
4. 更新後の`NodeLockBlob`（`formatMap`含む）を同一鍵・新IVで再暗号化→`lock.blobCiphertextB64`/`claimedTokens`を更新→メタJSONをアトミック保存（DESIGNv3 §1.5「操作の都度、即座に再暗号化・アトミック保存」）。

### 5.4 境界を跨ぐ移動・コピー（`memo:move`拡張、DESIGNv3 §1.12）
`memo:move`の引数に`srcLockContext?`/`destLockContext?`を追加して判定する。判定結果は以下の通り（★PLANv3実装補完。別ロック間の行は§7.5参照）:

| src（移動元） | dest（移動先） | 結果 |
|---|---|---|
| 通常（`srcLockContext`未指定） | 通常（`destLockContext`未指定） | 許可（既存v1と同じ通常の移動） |
| 通常 | ロック解除セッション配下（`destLockContext`指定） | 許可（外→内、DESIGNv3 §1.12） |
| ロック解除セッション配下（`srcLockContext`指定） | 通常 | **禁止**（`LOCK_BOUNDARY_VIOLATION`。内→外、DESIGNv3 §1.12） |
| ロックA配下 | ロックB配下（`lockToken`が異なる） | **禁止**（`LOCK_BOUNDARY_VIOLATION`。別ロック間、§7.5） |
| ロックA配下 | ロックA配下（同一`lockToken`） | 許可（境界を跨がないため制限なし、§5.3の通常の構造変更として処理） |

補足:
- **「許可（外→内）」時**: 対象に個別暗号化`.txtenc`が含まれる場合は`LOCK_CONTAINS_ENCRYPTED`。許可時は対象を難読化名へリネーム+暗号化し、dest側セッションの`nameMap`/`children`/`claimedTokens`へ組み込む（§5.3と同じ再暗号化保存を実行）。移動元の実`format`（`.txt`/`.md`）を`formatMap`にも引き継ぐ（§7.8、DESIGNv3 §1.13）。
- **「禁止」全般**: UIはドロップ自体を受け付けない（レンダラでも事前ブロックし、IPC側でも同一ルールを再検証する二重防御）。

### 5.5 タブ切替時のセッション一括破棄
レンダラの既存タブ切替処理（`requestCloseCurrentMemo`による未保存編集確認が先に完走した後）から、直前タブに対して`crypto:relockAllInTab{tabId}`を呼び出し、当該タブに紐づく全ロックセッションを一括破棄する。DESIGNv3 §1.11の確定順序（dirty確認→保存/破棄確定→タブ切替→セッション破棄）をそのまま踏襲する。

### 5.6 Markdown装飾コマンド実行フロー
1. レンダラ: 右クリックメニュー「文字色/太字/文字サイズ」選択→対応コマンドを`changeByRange`で実行し、選択範囲を`<span style="...">...</span>`でラップ/アンラップ（既存`textCommands.ts`と同パターン、Undo単位も同様に1トランザクション=1Undo, DESIGNv3 §2.2）。
2. CodeMirrorの`ViewPlugin`（`markdownDecorations.ts`）が文書変更を検知し、`markdownSanitize.ts`の許可リストでサニタイズしたHTMLを見た目として描画する（実データは常にMarkdownテキストのまま）。
3. 保存は既存`memo:save`/`crypto:saveEncrypted`をそのまま使用（追加IPC不要）。

### 5.7 画像貼り付けフロー
1. レンダラ: クリップボード/ドロップの画像データを取得→バイト数を計測（貼付け時点で既にメモリ上にあるため追加I/O不要, DESIGNv3 §2.6）。
2. `MARKDOWN_IMAGE_SIZE_WARN_BYTES`超なら実サイズ（約◯MB）を明記した確認ダイアログ（既存`ConfirmDialog`）を表示。
3. 続行時、Base64化し`![](data:image/png;base64,...)`をカーソル位置へ挿入（IPC不要、全てレンダラ内完結）。

### 5.8 `.txt`↔`.md`変換フロー
- **`.txt`→`.md`**: `memo:convertFormat{tabId, memoName, targetFormat:'md'}` → 拡張子のみリネーム（本文無変更, DESIGNv3 §2.4）。
- **`.md`→`.txt`**: レンダラが現在の本文から装飾タグ(`<span`)/画像データURI(`data:image/`)の有無を正規表現で検出→検出時のみ確認ダイアログ表示→続行後に同一の`memo:convertFormat{targetFormat:'txt'}`を呼ぶ（本文無変更、拡張子のみ）。
- 暗号化メモの場合は`crypto:encryptMemo`/`crypto:decryptMemoToPlain`実行時に元拡張子(`.txt`/`.md`)から`format`を自動判定し`.txtenc`の`format`フィールドへ反映する（新規IPCパラメータは不要）。

### 5.9 全文検索インデックスへのMarkdown反映
`searchIndex.ts`のインデックス構築/差分更新時、`.md`ファイルは本文を許可リストタグ除去（プレーンテキスト化）した上で通常の`.txt`と同様に本文インデックス対象にする（DESIGNv3 §2.6 Q11）。マッチ判定はタグ除去後のプレーンテキスト基準の完全一致とし、ライブプレビュー上のハイライト位置変換はbest-effortでよい（同Q11）。ロック中/セッション中の配下は既存ルール通り常に名前ごと除外する（DESIGNv3 §1.7 Q1）。

---

## 6. エラーハンドリング方針（追加分）

| 事象 | 方針 | 参照 |
|------|------|------|
| ロック対象/移動元にM6個別暗号化メモが混在 | `LOCK_CONTAINS_ENCRYPTED`。「暗号化済みのメモが含まれています。先に個別の暗号化を解除してください」 | DESIGNv3 §1.10/§1.12 |
| ロック解除中配下→外、または別ロックへの移動・コピー試行 | `LOCK_BOUNDARY_VIOLATION`。UIはドロップ自体を無効化（事前ブロック）し、IPC側でも同一ルールを再検証する二重防御 | DESIGNv3 §1.12、本PLANv3 §5.4/§7.5 |
| `lockContext`指定だがセッション失効/未存在 | `LOCK_SESSION_NOT_FOUND`。UIはツリーを再取得しロック中(🔒)表示へ戻す。**エラーコードを`_EXPIRED`/`_NOT_FOUND`に分割しない**: ノードロックセッションには時間経過によるタイムアウトが無く(DESIGNv3 §1.11「自動再ロックは設けない」)、明示的な再ロック/タブ離脱/タブ削除/アプリ終了のいずれかで即座に破棄されるため、「期限切れだが痕跡が残る」中間状態自体が存在しない。「ある」か「(既に破棄されて)無い」の二値のみのため単一コードで十分 | 本PLANv3 §5.3 |
| ロックパスワード誤り | 既存`DECRYPT_FAILED`を再利用（新規コード不要。本文含め一切返さない） | DESIGNv3 §1.5/§3 |
| メタ+`.bak`同時消失時のロック名前対応表喪失 | 既存の復旧カスケード（フラット再生成）に合流。名前対応の喪失は許容（追加冗長化なし） | DESIGNv3 §1.7 Q3 |

その他（Windows I/Oロック・ごみ箱送り失敗・メタ破損等）は既存方針（PLAN.md §6）をそのまま適用する。ノードロックのファイル操作（難読化名でのリネーム/削除）も既存`selfWriteRegistry`/リトライ機構にそのまま乗る。

---

## 7. 実装補完事項（確定・ユーザー確認済み）

DESIGNv3.mdの設計判断は変更していない。以下は、DESIGNv3.mdの確定判断を実装可能な形に具体化する過程で、DESIGNv3.mdに明記が無かったために本PLANv3で補った**実装補完事項**である（設計方針そのものの変更ではない）。各項目はユーザーに選択肢(推奨案+代替案)を提示し、**全項目とも推奨案で確定済み**。

### 7.1 `claimedTokens`の追加（実装補完・最重要）
DESIGNv3にはこのフィールドの記載が無い。本PLANv3が実装可能な粒度へ具体化する過程で、これが無いと以下の理由で実装が破綻することが判明したため補った（設計方針の変更ではなく、DESIGNv3 §1.2の既存確定要件「ロック中は🔒以外の情報を一切見せない」を実際に満たすための実装補完）。

理由: `tabService`は起動時・タブオープン時に「フォルダ直下の実ファイル」と「メタJSON上のノード」を突合し、対応の無い実ファイルをツリー末尾へフラット追加する（DESIGN.md §4.1「突合ロジック」の既存フォールバック）。ロック中ノードの子孫の難読化ファイルはメタ上`children:[]`のため対応が無く、このフォールバックに従うと**ロックで隠したはずの子孫ファイルが素性不明の孤児ノードとしてツリーに露出してしまう**（代替案「ファイル名パターンで判定」は誤判定リスクあり、「露出を許容」はDESIGNv3 §1.2の確定要件に反するため不採用）。`lock.claimedTokens`（占有中の難読化ファイル名の平文リスト）を持たせ、突合ロジックがこれに含まれるファイルを孤児判定から除外することで解消する。ランダムHEX文字列の列挙のみで名前・階層情報は含まないため、DESIGNv3 §1.9が既に許容している残存リスク（無作為名ファイルの個数は数えられる）と同水準であり、秘匿方針を損なわない。

### 7.2 `lockContext`方式によるIPC拡張（実装補完）
ロック解除セッション中の構造変更を専用チャネル群として新設せず、既存`memo:*`/`tree:updateStructure`に任意引数`lockContext`を追加する形にした（代替案「ロック専用の新規IPCチャネル群」はチャネル数倍増・保守コスト増のため不採用）。DESIGNv3全体が一貫して採る「既存機構の自然な延長」方針（§1.7の随所）に倣った実装上の選択。

### 7.3 名前の一意性スコープ（実装補完）
ロック配下の`memoName`（`NodeLockBlob.realMemoName`/`children`内）は**ブロブ内（同一ロックの兄弟間）でのみ一意であればよく、タブ全体の名前空間とは独立**と判断した。実ディスクファイル名は常に難読化トークンで一意性を担保するため（DESIGNv3 §1.4）、可視名の重複可能範囲がタブ全体からロック単位に縮小しても実害が無い（代替案「タブ全体で一意」はロック解除時に既存可視名との衝突リネームという不要な手間を生むため不採用）。

### 7.4 入れ子ロックを許可（実装補完）
`NodeLockBlob.children`の型が`MetaTreeNode[]`であり、`MetaTreeNode.lock`フィールドは元々再帰的に持てるため、型構造上そのまま自然にサポートされる。特別な実装は不要（代替案「v3スコープでは明示的に禁止」は不要な追加実装になるため不採用）。DESIGNv3に明記は無いが禁止する記述も無く、既存の型定義から自然に導かれる帰結として許可する判断とした。

### 7.5 異なるロックセッション間の移動を禁止（実装補完）
DESIGNv3 §1.12は「内→外」の移動・コピー禁止を明記するが、「別ロックへの移動」は明示的に言及していない。**別ロックへの移動も実質的に一方のロックから見て「外へ出る」操作に相当する**ため、「一方通行の金庫」の原則（DESIGNv3 §1.12「本方式は意図的に不可逆な制約」）を厳格に適用し、同様に`LOCK_BOUNDARY_VIOLATION`として禁止する判断とした（代替案「許可する」は技術的には安全だがドラッグ事故防止というDESIGNv3の設計意図と緊張関係があるため不採用）。

### 7.6 `crypto:relockAllInTab`の新設（実装補完）
DESIGNv3 §1.11は「タブから離れたら（別タブ選択で）即座にセッション破棄」とのみ規定し、実装方式（1件ずつ`relockNode`を呼ぶか一括か）には言及していない。タブ切替のたびに複数セッションへ個別にIPC往復するのは非効率なため、一括版チャネルを新設した（代替案「既存relockNodeをレンダラ側でループ呼び出し」はセッション数が多い場合にIPC往復が増えるため不採用）。

### 7.7 難読化変換時のファイル書込み順序（実装補完）
ロック実行時の暗号化+リネームは、M6暗号化変換フロー（PLAN.md §5.4）と同じ「新ファイル永続化(fsync)確認後に旧ファイルを削除」の順序を踏襲する（代替案「旧ファイルを先に削除」はクラッシュ時に旧新どちらも失われる窓が生じるため不採用）。DESIGNv3には明記が無いが、クラッシュ耐性の観点で既存パターンを踏襲するのが妥当と判断した。

上記7.1–7.7は、当初のPLANv3.md確定時点（M8/M9マイルストーン分割前）で発見・確定した実装補完事項である。以下7.8は、M10a実装完了後の交差ケース検証で追加発見された項目（2026-07-26追記）。

### 7.8 ノードロック×Markdown保存形式の交差ケースにおける`format`伝播（実装補完・2026-07-26追記）
DESIGNv3.md/PLANv3.mdとも当初、ノードロック（§1）とMarkdown保存形式（§2）を「独立機能」として設計しており（依存関係グラフ上も無関係）、この交差ケース自体が未検討だった。M10a実装完了後のreviewer/tester検証で「`.md`メモを含むサブツリーをロックすると、そのメモのMarkdown属性（`format`）が失われる」ギャップが発見され、ユーザー判断で「M10b（装飾ライブプレビュー）着手前にdesignerが設計してから実装する」方針が確定した。

designer検討の結果、以下を実装補完として確定する（詳細な理由・代替案の比較はDESIGNv3.md §1.13参照。本節はPLANv3としての実装可能な粒度への反映のみを記す）:
- `NodeLockBlob`/`NodeLockSessionEntry`に`nameMap`と対になる`formatMap: Record<string, 'plain' | 'markdown'>`を新設し、これをセッション内の`format`の唯一の真実源とする（§4参照。代替案「各メンバーの`.txtenc`ヘッダのみを真実源とし都度読み直す」は不採用、理由はDESIGNv3 §1.13）。
- `TreeNode`に`format?: 'plain' | 'markdown'`を新設し、レンダラへの伝播経路とする（§4参照）。
- 調査の過程で判明した関連ギャップとして、既存M6個別暗号化`crypto:open`のレスポンス型`CryptoOpenResult`にも`format`が無く、暗号化`.md`メモの個別開封時にレンダラがMarkdown判定できない点も、ノードロックの有無に関係なくM10bのゴール未達成に直結するため、同一箇所（本項目）で併せて修正する。
- 対象となる関数レベルの詳細な変更点（`readSubtreeMember`/`lockNode`/`unlockNode`/`writeSessionMemoContent`/`moveIntoSession`/`createMemoInSession`/`renameMemoInSession`/`deleteMemosInSession`/`duplicateMemoInSession`/`moveWithinSession`/`reencryptSessionBlob`/`buildOriginTreeNode`/`buildSessionTreeNodes`/`metaStore.reconcile`/`crypto:open`ハンドラ）は[M10b-markdown-live-preview.md](milestones/M10b-markdown-live-preview.md)にdeveloper向けの実装単位で記載する。
- セッション配下メモの`memo:convertFormat`は引き続き対象外（M10a時点の`NAME_INVALID`拒否を変更しない）。`formatMap`導入により技術的には対応可能になるが、変換前確認ダイアログ等のUI導線はM10cスコープであり、必要になった時点で改めて判断する（新たなエラーコードの追加は無し）。

上記7.1–7.8以外に、DESIGNv3.mdの確定判断と矛盾する箇所・実装不可能な箇所は発見されなかった。

---

## 8. 次のアクション

1. ~~本PLANv3.mdの内容についてユーザー確認を得る（特に§7 実装補完事項の7点）。~~ **完了（§7.1〜§7.7とも推奨案で確定）**
2. ~~マイルストーン分割（PLAN.md §7相当）を行う（機能1・機能2は独立度が高いため別マイルストーンとして分割する方向、DESIGNv3 §6-5）。~~ **完了。`docs/v3/milestones/`配下に3分割で作成**:
   - [M8-node-lock-core.md](milestones/M8-node-lock-core.md) — ノードロック基盤（単発のロック/解除/再ロック）
   - [M9-node-lock-session-ops.md](milestones/M9-node-lock-session-ops.md) — ノードロック応用（セッション中操作・境界移動・タブ切替。M8依存）
   - [M10-markdown-preview.md](milestones/M10-markdown-preview.md) — Markdown＋ライブプレビュー（M8/M9とは独立）
3. マイルストーン分割後、developer への実装依頼を行う。**次のステップ（ユーザーからの明示的な着手指示待ち）**
