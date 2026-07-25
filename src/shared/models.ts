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
  | 'UNKNOWN';

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
