# data-model.md — 型定義 / データ構造リファレンス

> 本ファイルは PLAN.md §4「主要データ構造 / 型」を **実装時にそのままコピー&ペースト・参照できるよう転記**した派生ドキュメントです。
> 正本は [PLAN.md](../PLAN.md) §4 / [DESIGN.md](../DESIGN.md) §3。設計理由・トレードオフの背景は正本の該当節を参照してください。
> TypeScript 型は `src/shared/models.ts`、IPC 契約は `src/shared/ipc-contract.ts` に定義する（PLAN §3 ディレクトリ構成）。
> 全 JSON に `schemaVersion` + `appVersion` を記録する（DESIGN §3.2）。

---

## 1. タブ単位メタ JSON（`.tabtreenote.json`、フォルダ内隠しメタ）— PLAN §4.1

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

- メタは「ファイル名参照 + ツリー構造」のみを持ち、**暗号化状態のフラグは持たない**（暗号化かどうかは実ファイルの拡張子 `.txtenc` が真実源。DESIGN §2.9）。
- 「パスワードヒント」を保存する場合は該当 `.txtenc` ファイル内（平文フィールド）に格納する（DESIGN §2.9）。メタ JSON には保存しない。
- **型の分離**: メタ JSON に永続化されるツリー要素は `MetaTreeNode`（`encrypted` を**持たない**）。`tab:openTree` がレンダラへ返す実行時ツリーは `TreeNode`（走査時に拡張子から導出した `encrypted` を付与）。**メタ JSON へ書き出すのは常に `MetaTreeNode`** であり、`encrypted` 付き `TreeNode` をそのままシリアライズしてはならない（真実源は拡張子 `.txtenc`、PLAN §8-1）。
- **突合ロジック**: タブを開くとき `metaStore` が (a) メタ JSON の tree（`MetaTreeNode[]`）と (b) フォルダ直下実ファイル走査結果（`.txt`/`.txtenc`、直下のみ、シンボリックリンク/ジャンクション無視, DESIGN §2.2）を突合し、実行時用の `TreeNode[]`（各ノードに拡張子由来の `encrypted` を付与）を構築して返す。メタにあり実体が無いノードは除外、実体にありメタに無いファイルはツリー末尾へフラット追加。逆にメタを保存する際は `encrypted` を落として `MetaTreeNode[]` に変換してから永続化する。

---

## 2. アプリ設定 JSON（ユーザー設定ディレクトリ or アプリ配置フォルダ）— PLAN §4.2

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

---

## 3. 暗号化ファイル `.txtenc` フォーマット — PLAN §4.3（DESIGN §2.9）

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

- scrypt コストパラメータ（N/r/p/keyLen）は**ファイルに記録**し、復号時はファイル内の値を使う（将来のパラメータ引き上げに耐える）。初回/パスワード変更時は本 PLAN 既定 **N=32768（2^15）/r=8/p=1/keyLen=32（メモリ約 32MB 目安）** で生成。
- **鍵導出は必ず非同期版 `crypto.scrypt`（コールバック API）を使う**。`crypto.scryptSync` は使用しない（同期版はメインのイベントループをブロックし UI/IPC/トレイをフリーズさせる）。`util.promisify(crypto.scrypt)` 等で `await` する。第 4 引数 `options` で `maxmem` を明示的に十分な値（例 64MB）へ引き上げる（N=32768/r=8 では既定の `maxmem`（32MB）が不足し得る）。`N`/`r`/`p`/`keyLen` は `options` および引数で指定する。
- salt はパスワード維持中は不変、パスワード変更時のみ再生成。**IV は書き込み毎に必ず新規**（DESIGN §2.9 IV 再利用禁止）。
- `.bak` の中身も同フォーマットの暗号化済みデータ（平文は残さない, DESIGN §2.6）。

---

## 4. IPC 共通型（`src/shared`）— PLAN §4.4

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

## 5. 定数（`src/shared/constants.ts`）

PLAN §3 のディレクトリ構成より、`constants.ts` に集約する主な定数:
- 拡張子: `.txt` / `.txtenc`
- 一時ファイルプレフィックス（例 `.~tmp~<ランダム>~<元名>`、DESIGN §3.3）
- スキーマ版（`schemaVersion`）・既定値
- `.txtenc` の `magic` = `"TTNENC"` / `formatVersion` = 1
```
