// src/shared/models.ts
// Type definitions shared across main / preload / renderer.
// Transcribed verbatim from docs/data-model.md §4 (source of truth: PLAN.md §4 / DESIGN.md §3).
// Do not add runtime logic here: this module must stay import-safe from the sandboxed renderer.

/** Discriminated-union result type used for all IPC boundaries (docs/00-core-principles.md §1). */
export type Result<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; path?: string } };

export type ErrorCode =
  | 'NAME_DUPLICATE'
  | 'NAME_INVALID'
  | 'NOT_FOUND'
  | 'IO_LOCKED'
  | 'TRASH_FAILED'
  | 'DECRYPT_FAILED'
  | 'CONFLICT'
  | 'META_CORRUPT'
  | 'LONG_PATH'
  | 'UNKNOWN'
  // --- v3 M8: ノード単位パスワードロック（docs/v3/DESIGNv3.md §1、docs/v3/milestones/M8-node-lock-core.md）。
  | 'LOCK_CONTAINS_ENCRYPTED'
  | 'LOCK_SESSION_NOT_FOUND'
  // --- v3 M9b: ロック境界を跨ぐ移動・コピー（「一方通行の金庫」、docs/v3/DESIGNv3.md §1.12、
  // docs/v3/milestones/M9b-node-lock-boundary-move.md）。
  | 'LOCK_BOUNDARY_VIOLATION'
  // --- v3 §1.15: ロック中(セッション無し)ノードの直接削除の禁止（docs/v3/DESIGNv3.md §1.15、
  // `LOCK_BOUNDARY_VIOLATION` とは意味が異なる＝あちらは境界跨ぎの移動/コピー専用）。
  | 'NODE_LOCKED';

export type Eol = 'crlf' | 'lf' | 'cr';

// hash フィールドはすべて「ディスク上の実ファイルの内容そのもの（ファイル全体のバイト列）のハッシュ」（00-core-principles.md §6）。
export interface MemoReadResult {
  contentLF: string;
  encoding: 'utf-8' | 'utf-8-bom' | 'shift_jis';
  eol: Eol;
  encrypted: boolean;
  hash: string; // 実ファイル全体のバイト列ハッシュ
}

/** 保存後の実ファイル全体（バイト列）のハッシュ（次回競合判定用）。 */
export interface SaveResult {
  savedHash: string;
}

export interface TabInfo {
  id: string;
  name: string;
  folderPath: string;
}

/** 簡易な色/種別ラベル（DESIGN §2.2）。 */
export interface Label {
  color: string | null;
  kind: string | null;
}

/** メモ毎エディタ設定（任意。null は「アプリ既定に従う」, DESIGN §3.2）。 */
export interface MemoEditorSettings {
  wrap?: 'none' | 'chars' | 'window';
  font?: string | null;
}

/**
 * 【v3 M8: ノード単位パスワードロック】ロック中ノードが永続化するブロブ本体（`MetaTreeNode.lock`）。
 * 復号すると `NodeLockBlob`（JSON）になる（docs/v3/DESIGNv3.md §1.3/§1.6、
 * docs/v3/PLANv3.md §4、docs/v3/milestones/M8-node-lock-core.md）。
 * 既存の編集ロック用 `MetaTreeNode.locked`/`TreeNode.locked`（boolean）とは別物であり衝突しない
 * （フィールド名 `lock` は既存に無い名前）。
 */
export interface NodeLock {
  kdf: { algo: 'scrypt'; N: number; r: number; p: number; keyLen: number };
  saltB64: string;
  ivB64: string;
  tagB64: string;
  hint?: string;
  /** 復号後: `NodeLockBlob`（JSON）。 */
  blobCiphertextB64: string;
  /**
   * 【実装補完・必須】このロックが占有する難読化ファイル名（起点ノード自身を含む）の平文一覧。
   * `metaStore` の実ファイル/メタ突合ロジックが「メタ対応の無い実ファイル」を孤児としてツリーへ
   * フラット追加(=存在の露出)してしまうのを防ぐために必要（PLANv3 §7.1、M8-node-lock-core.md）。
   * ランダムHEX文字列の列挙のみで名前・階層情報は一切含まない。
   */
  claimedTokens: string[];
}

/**
 * `NodeLock.blobCiphertextB64` の復号後の中身（docs/v3/DESIGNv3.md §1.3、docs/v3/PLANv3.md §4）。
 * IPC境界を越えない内部専用の型（メインプロセス内でのみ組み立て/パースする）だが、データモデルの
 * 一部として本ファイルに記す。
 */
export interface NodeLockBlob {
  /** ロック起点ノード自身の元の表示名。起点ノード自身はこのフィールドで表現され、children には含まれない。 */
  realMemoName: string;
  /** 配下の「子」ノードのみ（起点ノード自身は含まない）。内部は平文表現でよい（ブロブ自体が暗号化されているため）。 */
  children: MetaTreeNode[];
  /** realName -> obfuscatedFileName（起点ノード自身の分も含む）。 */
  nameMap: Record<string, string>;
  /**
   * 【2026-07-26追記・v3 M10b前提】realName -> 'plain' | 'markdown'（`nameMap` と同じキー集合。
   * 起点ノード自身の分も含む）。ノードロック化（`.txtenc`）は個々のヘッダの `format` を参照せず
   * 拡張子由来の判定を失うため、Markdown属性をブロブ側で多重化して保持する
   * （DESIGNv3.md §1.13「伝播の設計」、docs/v3/milestones/M10b-markdown-live-preview.md §0.1）。
   */
  formatMap: Record<string, 'plain' | 'markdown'>;
}

/**
 * 【永続化専用】ツリーノード。メタJSON（`.tabtreenote.json`）の tree に実際にシリアライズされる要素。
 * encrypted を持たない: 暗号化状態の真実源は実ファイル拡張子 .txtenc であり、メタJSONには保存しない
 * (data-model.md §1 / §4)。
 */
export interface MetaTreeNode {
  memoName: string;
  expanded: boolean;
  label?: Label;
  editor?: MemoEditorSettings;
  /** 編集ロック（true の間、本文の編集を禁止する。リネーム/削除等ファイル操作は対象外, developer 判断）。 */
  locked?: boolean;
  /**
   * 【v3 M8】存在する場合「ノードロック中」（DESIGNv3 §1.6）。children は常に []。
   * 既存の編集ロック用 `locked` とは別概念。
   */
  lock?: NodeLock;
  children: MetaTreeNode[];
}

/**
 * 【実行時/UI専用】ツリーノード。`tab:openTree` のメタ+実ファイル突合結果として構築される読み取り専用スナップショット。
 * この型はメタJSONへシリアライズしない（永続化には必ず MetaTreeNode を使う）。
 */
export interface TreeNode {
  readonly memoName: string;
  readonly encrypted: boolean;
  readonly expanded: boolean;
  readonly label?: Label;
  readonly editor?: MemoEditorSettings;
  readonly locked?: boolean;
  /**
   * 【v3 M8: ノードロック】true: ロック中(セッション無し)の起点ノード。UIは常に「🔒(ロック中)」
   * 表示、children は空（docs/v3/DESIGNv3.md §1 冒頭「フィールド名の確定」で `locked` との型衝突を
   * 避けるため別名に確定。docs/v3/milestones/M8-node-lock-core.md 参照）。
   */
  readonly nodeLocked?: true;
  /**
   * ロック解除セッション配下（起点＋子孫全て）に付与。`crypto:unlockNode` が返した lockToken と
   * 同一値。【reviewer指摘 M9b-R1-01】入れ子ロック済み（未解除）の `nodeLocked` プレースホルダも
   * 含め、このセッション配下の全ノードに一律付与する（かつてはプレースホルダにだけ付与しない
   * 特例があったが、「境界跨ぎ判定（DESIGNv3 §1.12「一方通行の金庫」）が `lockToken` の有無を
   * ドラッグ元スコープの判定に使う」設計と衝突し、回帰・穴の原因になったため廃止した）。
   * 「このセッションの一部として直接編集可能ではない」（リネーム/暗号化等の導線を隠す）ことは、
   * 代わりに `nodeLocked` フラグ自体で判定すること。
   */
  readonly lockToken?: string;
  /**
   * 【2026-07-26追記・v3 M10b前提】このメモがMarkdown（`.md`由来）かどうか（`undefined`=不明/
   * 平文相当外）。平文メモ・ロック解除セッション配下メンバーには設定するが、通常領域の未開封
   * `.txtenc`ノード・入れ子ロック済み(未解除)プレースホルダは `undefined` のまま（実体はパスワード
   * 復号を経ないと分からないため, docs/v3/milestones/M10b-markdown-live-preview.md §0.1）。
   */
  readonly format?: 'plain' | 'markdown';
  readonly children: readonly TreeNode[];
}

/** タブ単位メタJSON（`.tabtreenote.json`）全体。 */
export interface TabMeta {
  schemaVersion: number;
  appVersion: string;
  tree: MetaTreeNode[];
}

/** メモ1件の情報（memo:create / memo:duplicate / crypto:encryptMemo 等の返却）。 */
export interface MemoInfo {
  memoName: string;
  encrypted: boolean;
}

/** タブを開いた際のツリースナップショット（tab:openTree の返却）。 */
export interface TreeSnapshot {
  readonly tabId: string;
  readonly tree: readonly TreeNode[];
}

/** アプリ設定JSON（`AppSettings` 全体）。 */
export interface AppSettings {
  schemaVersion: number;
  appVersion: string;
  tabs: { id: string; name: string; folderPath: string }[]; // 並び順は配列順が正本（order フィールドは持たない）
  window: {
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
    treeWidth: number;
    treeSide: 'left' | 'right';
  };
  theme: 'light' | 'dark';
  /** UI（タブ・ツリー・ボタン・設定画面等、エディタ本文を除く）の文字サイズ倍率。既定 1（100%）。 */
  uiFontScale: number;
  /** 起動時に自動で開くメモ（ユーザー要望。前回開いていたメモを復元）。未使用/存在しない場合は null。 */
  lastOpened: { tabId: string; memoName: string } | null;
  editorDefaults: {
    wrap: 'none' | 'chars' | 'window';
    tabWidth: number;
    softTab: boolean;
    showLineNumbers: boolean;
    fontSize: number;
  };
  autosave: { plainDebounceMs: number; encryptedDebounceMs: number };
  links: { openTrigger: 'ctrlClick' | 'singleClick' | 'doubleClick'; confirmBeforeOpen: boolean };
  encoding: { defaultSave: 'utf-8' };
  eol: { policy: 'preserve' | 'crlf' | 'lf' | 'cr' };
  shortcuts: Record<string, string>;
}

/**
 * 全文検索1ヒット分の情報（`search:global` の返却要素, M3-search.md「少なくともヒットした
 * タブ/メモ名・一致箇所へジャンプできる情報を含める」）。
 */
export interface SearchHit {
  tabId: string;
  tabName: string;
  memoName: string;
  encrypted: boolean;
  /** 'name' = メモ名一致、'body' = 本文一致。暗号化メモは本文を対象外のため常に 'name'（DESIGN §2.4）。 */
  matchField: 'name' | 'body';
  /** matchField==='body' のときのみ設定（1-origin の行番号）。 */
  lineNumber?: number;
  /** matchField==='body' のときのみ設定。一致した行のテキスト（結果一覧のプレビュー表示用）。 */
  lineText?: string;
  /** matchField==='body' のときのみ設定。`contentLF`（LF正規化済み本文）中の一致開始/終了オフセット文字数（結果ジャンプ時にエディタの選択範囲へ変換する）。 */
  matchStart?: number;
  matchEnd?: number;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** settings:set の部分更新用（深い部分更新を許容）。 */
export type AppSettingsPatch = DeepPartial<AppSettings>;
