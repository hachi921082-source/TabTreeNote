// src/shared/ipc-contract.ts
// 全 IPC チャネル名の名前空間定義（PLAN.md §2）。
// M0 では骨格（チャネル名 + 通知イベント名）のみを確定した。M1 で tab/memo の基本チャネル
// （list/register/create/openTree, read/readWithEncoding/save/create/rename）と
// settings:get/set の引数/返却型・`PreloadApi` を実装する
// (docs/milestones/M1-file-core.md「このフェーズで扱う IPC チャネル」)。
//
// 命名規則: 名前空間付き文字列（例 `tab:list`, `memo:read`）。ipcMain.handle 側と
// ipcRenderer.invoke 側の両方でこの定数を参照し、チャネル名の文字列リテラルを分散させない。
//
// 返却型は PLAN §2 の表記に合わせ「成功時ペイロード型」のみを記す（実際の IPC 応答は
// 00-core-principles.md §1 の規約により常に `Result<T>` でラップする。`Result` とだけ
// 表記されているチャネルは `Result<void>`）。
import type {
  AppSettings,
  AppSettingsPatch,
  Eol,
  ErrorCode,
  MemoInfo,
  MemoReadResult,
  MetaTreeNode,
  Result,
  SaveResult,
  SearchHit,
  TabInfo,
  TreeNode,
  TreeSnapshot
} from './models';

/** リクエスト/レスポンス型 IPC（ipcMain.handle / ipcRenderer.invoke）のチャネル名一覧。 */
export const IpcChannels = {
  tab: {
    list: 'tab:list',
    register: 'tab:register',
    create: 'tab:create',
    rename: 'tab:rename',
    remove: 'tab:remove',
    reorder: 'tab:reorder',
    openTree: 'tab:openTree',
    /** タブの登録フォルダをエクスプローラで開く（ユーザー要望）。 */
    openFolder: 'tab:openFolder'
  },
  memo: {
    read: 'memo:read',
    readWithEncoding: 'memo:readWithEncoding',
    save: 'memo:save',
    create: 'memo:create',
    rename: 'memo:rename',
    delete: 'memo:delete',
    duplicate: 'memo:duplicate',
    move: 'memo:move',
    /** プロパティ表示（ファイル情報+文字数カウント, ユーザー要望）。 */
    getProperties: 'memo:getProperties',
    /** エクスプローラでファイルを選択表示する（プロパティ画面「ファイルの場所を開く」）。 */
    revealInFolder: 'memo:revealInFolder',
    /**
     * v3 M10a: `.txt`⇔`.md`変換（拡張子のみリネーム、本文は無変更, DESIGNv3 §2.4）。
     * 呼び出し元UI（変換前の装飾/画像検出・確認ダイアログ）は M10c スコープ
     * （docs/v3/milestones/M10a-markdown-format-core.md）。
     */
    convertFormat: 'memo:convertFormat'
  },
  tree: {
    updateStructure: 'tree:updateStructure'
  },
  search: {
    global: 'search:global',
    historyGet: 'search:history:get',
    historyAdd: 'search:history:add'
  },
  crypto: {
    encryptMemo: 'crypto:encryptMemo',
    decryptMemoToPlain: 'crypto:decryptMemoToPlain',
    open: 'crypto:open',
    saveEncrypted: 'crypto:saveEncrypted',
    changePassword: 'crypto:changePassword',
    lock: 'crypto:lock',
    /** v3 M8: サブツリーをロックする（docs/v3/milestones/M8-node-lock-core.md）。 */
    lockNode: 'crypto:lockNode',
    /** v3 M8: ロック中サブツリーをパスワードで復号しセッション開始する。 */
    unlockNode: 'crypto:unlockNode',
    /** v3 M8: 単一ロックセッションの明示的破棄（ファイル操作なし）。 */
    relockNode: 'crypto:relockNode',
    /** v3 M9c: 指定タブに紐づく全ロックセッションを一括破棄（タブ切替時用, ファイル操作なし）。 */
    relockAllInTab: 'crypto:relockAllInTab',
    /**
     * v3 §1.14: ロックを恒久的に解除する（`docs/v3/DESIGNv3.md` §1.14）。`lockNode` と対称に、
     * 起点+配下全体を復号し実名の平文ツリーへ昇格させる（`lockContext` 省略時）、または
     * 親セッションの鍵で再暗号化して親セッションへマージする（`lockContext` 指定時、入れ子ロック
     * 自体の恒久解除）。既存の一時セッション用「ロックを解除」（`unlockNode`）とは別の、不可逆な
     * 別操作。
     */
    removeNodeLock: 'crypto:removeNodeLock'
  },
  link: {
    openExternal: 'link:openExternal',
    resolveMemo: 'link:resolveMemo'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set'
  },
  editor: {
    /**
     * レンダラが「現在開いている(かつ未保存の変更があるか)」状態をメインへ通知する
     * （M4 新設。PLAN §2 の IPC チャネル一覧には明記が無いが、DESIGN §3.3「編集中(未保存の
     * 変更がある)メモに対して外部からの変更を検知した場合」の判定にはメイン側が dirty 状態を
     * 知る必要があり、その手段として追加した最小限の一方向通知。developer 判断、reviewer
     * 確認事項）。main/watch/activeMemoState.ts が保持し、watch/watcher.ts の
     * `evt:conflict`/`evt:externalChange` 振り分けに使う。
     */
    reportActive: 'editor:reportActive'
  },
  app: {
    getInfo: 'app:getInfo'
  },
  window: {
    /** 常時最前面表示のトグル（ユーザー要望。セッション内のみ、設定への永続化はしない）。 */
    setAlwaysOnTop: 'window:setAlwaysOnTop',
    /** Windowsログイン時の自動起動トグル（ユーザー要望）。状態はOS（レジストリ）が真実源。 */
    setOpenAtLogin: 'window:setOpenAtLogin',
    getOpenAtLogin: 'window:getOpenAtLogin'
  },
  dialog: {
    /**
     * ネイティブのフォルダ選択ダイアログを開く（developer 判断。`window.prompt()` は
     * Electron のレンダラープロセスでは何も表示せず即 `null` を返す未実装機能のため、
     * タブ登録/新規タブ作成の絶対パス手入力の代替として追加した）。
     */
    pickFolder: 'dialog:pickFolder'
  }
} as const;

/** メイン→レンダラの一方向イベント（`webContents.send` + preload 購読関数, PLAN §2.7）。 */
export const IpcEvents = {
  externalChange: 'evt:externalChange',
  conflict: 'evt:conflict',
  indexUpdated: 'evt:indexUpdated',
  metaRecovered: 'evt:metaRecovered',
  trashFallback: 'evt:trashFallback',
  opError: 'evt:opError',
  /** エディタのネイティブ右クリックメニュー「プロパティ」選択時（main/index.ts の
   * `context-menu` ハンドラが現在アクティブなメモに対して発火する, ユーザー要望）。 */
  showProperties: 'evt:showProperties',
  /** エディタのネイティブ右クリックメニューの各種コマンド選択時（ユーザー要望: 元に戻す/変換/
   * チェック/書式ショートカット等）。main は CodeMirror の内部状態を持たないため、実行自体は
   * レンダラ側（CodeMirrorEditor.tsx）へ委譲する。 */
  editorMenuCommand: 'evt:editorMenuCommand'
} as const;

/** `app:getInfo` の返却型（PLAN §2.6）。 */
export interface AppInfo {
  appVersion: string;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// M1: tab / memo / settings チャネルの引数型（PLAN §2.1/§2.2）
// ---------------------------------------------------------------------------

/** メモ追加位置（DESIGN §2.2）。before/after/child は `anchorMemoName` とセットで使う。 */
export type AddPosition = 'before' | 'after' | 'child' | 'first' | 'last';

export interface TabRegisterArgs {
  folderPath: string;
}

/** `dialog:pickFolder` の引数（developer 判断）。`defaultPath` はダイアログの初期表示先。 */
export interface DialogPickFolderArgs {
  defaultPath?: string;
}

/** `window:setAlwaysOnTop` の引数（ユーザー要望）。 */
export interface WindowSetAlwaysOnTopArgs {
  enabled: boolean;
}

/** `window:setOpenAtLogin` の引数（ユーザー要望: 起動時にトレイへ自動常駐）。 */
export interface WindowSetOpenAtLoginArgs {
  enabled: boolean;
}

export interface TabCreateArgs {
  /** 省略時はアプリ本体直下の `data` フォルダを既定の作成先とする（developer 判断、ポータブル性優先）。 */
  parentDir?: string;
  name: string;
}

export interface TabOpenTreeArgs {
  tabId: string;
}

/** `tab:openFolder` の引数（ユーザー要望: タブバー右クリック「タブの場所を開く」）。 */
export interface TabOpenFolderArgs {
  tabId: string;
}

export interface MemoReadArgs {
  tabId: string;
  memoName: string;
  /** v3 M9a: 指定時はロック解除セッション配下の実名として解決する（PLANv3 §5.3）。 */
  lockContext?: LockContext;
}

export interface MemoReadWithEncodingArgs {
  tabId: string;
  memoName: string;
  encoding: MemoReadResult['encoding'];
}

export interface MemoSaveArgs {
  tabId: string;
  memoName: string;
  contentLF: string;
  eol: Eol;
  encoding: MemoReadResult['encoding'];
  expectedHash?: string;
  /** v3 M9a: 指定時はロック解除セッション配下の実名として解決する（PLANv3 §5.3）。 */
  lockContext?: LockContext;
}

export interface MemoCreateArgs {
  tabId: string;
  name: string;
  position: AddPosition;
  anchorMemoName?: string;
  /**
   * v3 M10a: 'markdown' 指定時は拡張子 `.md` でファイル作成する（省略時 'plain' = `.txt`,
   * DESIGNv3 §2.4）。作成先UI（「通常メモ」「Markdownメモ」の選択導線）は M10c スコープ
   * （docs/v3/milestones/M10a-markdown-format-core.md）。
   */
  format?: 'plain' | 'markdown';
  /** v3 M9a: 指定時はロック解除セッション配下へ作成する（PLANv3 §5.3）。 */
  lockContext?: LockContext;
}

export interface MemoRenameArgs {
  tabId: string;
  oldName: string;
  newName: string;
  /** v3 M9a: 指定時はロック解除セッション配下の実名リネームとして解決する（PLANv3 §5.3）。 */
  lockContext?: LockContext;
}

export interface MemoGetPropertiesArgs {
  tabId: string;
  memoName: string;
}

export interface MemoRevealInFolderArgs {
  tabId: string;
  memoName: string;
}

/** プロパティ画面「文字数カウント」（ユーザー要望。総字数/改行・空白を除く字数/行数のみ）。 */
export interface MemoCharCounts {
  total: number;
  excludingWhitespace: number;
  lines: number;
}

/** `memo:getProperties` の返却型（ユーザー要望）。暗号化メモは復号しないため charCounts は null。 */
export interface MemoProperties {
  memoName: string;
  filePath: string;
  createdAtMs: number;
  modifiedAtMs: number;
  sizeBytes: number;
  encrypted: boolean;
  charCounts: MemoCharCounts | null;
}

/** `evt:showProperties` のペイロード。 */
export interface ShowPropertiesPayload {
  tabId: string;
  memoName: string;
}

/**
 * エディタ右クリックメニューの「変換」「元に戻す」等（ユーザー要望）。CodeMirror の内部状態
 * （選択範囲/Undo履歴）を直接操作する必要があるため、main はコマンド名だけを送りレンダラの
 * CodeMirrorEditor.tsx が実際の処理を行う（editor/textCommands.ts）。
 */
export type EditorTextCommand =
  | 'undo'
  | 'redo'
  | 'deleteSelection'
  | 'invertCase'
  | 'toUpperCase'
  | 'toLowerCase'
  | 'toHiragana'
  | 'toKatakana'
  | 'toHalfWidth'
  | 'toFullWidth'
  | 'tabsToSpaces'
  | 'spacesToTabs'
  | 'toggleCheckbox';

/**
 * v3 M10b: Markdown装飾コマンド（文字色/太字/文字サイズ, DESIGNv3 §2.2）。
 * `src/renderer/editor/decorationCommands.ts` が `<span style="...">` のラップ/アンラップとして
 * 実行する。`value: ''`（色/文字サイズ解除の明示ボタン）は既存の同値トグルとは別に、常に
 * 対応する CSS プロパティを除去する特別値として扱う（decorationCommands.ts 参照）。
 *
 * 【post-M10 bugfix】元々はエディタ右クリックメニュー（`evt:editorMenuCommand` の
 * `kind: 'decoration'`）経由でも実行できたが、ユーザーがこの経路に気づけなかったため
 * `MarkdownToolbar` の専用ボタンへ一本化し、右クリックメニュー側の装飾サブメニュー
 * （`src/main/index.ts`）は削除した。ボタンは同一レンダラプロセス内で
 * `CodeMirrorEditorHandle.runDecorationCommand` を直接呼ぶため、IPC経由の `EditorMenuCommandPayload`
 * には（`textCommand`等と異なり）対応するバリアントを持たない。
 */
export type MarkdownDecorationCommand =
  | { command: 'color'; value: string }
  | { command: 'bold' }
  | { command: 'fontSize'; value: string };

/** `evt:editorMenuCommand` のペイロード。 */
export type EditorMenuCommandPayload =
  | { kind: 'textCommand'; command: EditorTextCommand }
  | { kind: 'setWrap'; wrap: 'none' | 'chars' | 'window' }
  | { kind: 'toggleLineNumbers' }
  | { kind: 'toggleWhitespace' }
  | { kind: 'fontSize'; action: 'increase' | 'decrease' | 'reset' };

/** `evt:metaRecovered` のペイロード（00-core-principles.md §9）。 */
export interface MetaRecoveredPayload {
  message: string;
  tabId?: string;
}

// ---------------------------------------------------------------------------
// M2: tab の残りチャネル（rename/remove/reorder）、memo の残りチャネル
// （delete/duplicate/move）、tree:updateStructure の引数型（PLAN §2.1/§2.2、
// docs/milestones/M2-tree-ui.md）。
// ---------------------------------------------------------------------------

export interface TabRenameArgs {
  tabId: string;
  newName: string;
}

export interface TabRemoveArgs {
  tabId: string;
  /** 既定はフォルダ削除しない（タブ登録解除のみ）。true 時はごみ箱送りを試みる。 */
  deleteFolder?: boolean;
}

export interface TabReorderArgs {
  /** 新しい並び順。`AppSettings.tabs` 配列自体をこの順に並べ替える（Fix7、`order` フィールドは持たない）。 */
  orderedTabIds: string[];
}

export interface MemoDeleteArgs {
  tabId: string;
  memoNames: string[];
  /** 既定（未指定/false）はごみ箱送り。true はユーザー承諾後の直接削除（無確認で true にしないこと）。 */
  forceDirect?: boolean;
  /** v3 M9a: 指定時はロック解除セッション配下の実名として解決する（PLANv3 §5.3）。 */
  lockContext?: LockContext;
}

export interface MemoDuplicateArgs {
  tabId: string;
  memoName: string;
  /** v3 M9a: 指定時はロック解除セッション配下の実名として解決する（PLANv3 §5.3）。 */
  lockContext?: LockContext;
}

export interface MemoMoveArgs {
  srcTabId: string;
  memoNames: string[];
  destTabId: string;
  destPosition: AddPosition;
  /**
   * before/after/child 指定時の移動先アンカー。PLAN §2.2 の `memo:move` 引数表は簡略記法
   * （`destPosition` のみ）だが、`memo:create` と対称の anchor パターン（`AddPosition` は
   * 元々 anchor 必須の位置指定を含む）で実装上補完した（developer 判断。first/last のみなら
   * 省略可）。
   */
  destAnchorMemoName?: string;
  /** true = コピー（元を残す）、false/未指定 = 移動（DESIGN §2.2 の Ctrl 併用コピー）。 */
  copy: boolean;
  /**
   * v3 M9b: 移動元がロック解除セッション配下の場合に指定する（PLANv3 §5.4「境界を跨ぐ移動・
   * コピー」）。「一方通行の金庫」（DESIGNv3 §1.12）: 指定時（内→外、または destLockContext が
   * 異なる別ロックの場合）は `LOCK_BOUNDARY_VIOLATION` で禁止する。省略時（通常領域）は既存v1と
   * 同じ挙動。
   */
  srcLockContext?: LockContext;
  /**
   * v3 M9b: 移動先がロック解除セッション配下の場合に指定する（PLANv3 §5.4）。`srcLockContext`
   * 省略時（通常領域→セッション配下、「外→内」）は許可し、対象を難読化名へリネーム+暗号化して
   * dest側セッションの`nameMap`/`children`/`claimedTokens`へ組み込む。`srcLockContext`指定時は
   * `lockToken`が同一の場合のみ許可（境界を跨がない通常の構造変更、PLANv3 §5.3）。
   */
  destLockContext?: LockContext;
}

export interface TreeUpdateStructureArgs {
  tabId: string;
  /** 新しいツリー構造全体（並び順・階層・開閉・ラベルを含む）。実ファイル集合と厳密一致すること。 */
  treeStructure: MetaTreeNode[];
  /**
   * v3 M9a: 指定時は `treeStructure` をロック解除セッション配下の実行時構造（実名ベース、
   * 起点ノード自身を除く子ツリー）として解釈し、対象セッションの `nameMap` と厳密一致するか
   * 検証する（PLANv3 §5.3）。
   */
  lockContext?: LockContext;
}

/** `evt:trashFallback` のペイロード（ごみ箱送り失敗 → UI で直接削除確認, PLAN §2.7/§2.6）。 */
export interface TrashFallbackPayload {
  tabId: string;
  memoNames: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// M3: search:global / search:history:get / search:history:add の引数型
// （PLAN §2.3、docs/milestones/M3-search.md）。
// ---------------------------------------------------------------------------

/** 全文検索の対象範囲（M3-search.md）。 */
export type SearchScope = 'all' | 'currentTab';

/** 全文検索オプション（developer 判断。現在メモ内検索の CodeMirror 側オプションとは独立）。 */
export interface SearchOptions {
  caseSensitive?: boolean;
  useRegex?: boolean;
}

export interface SearchGlobalArgs {
  scope: SearchScope;
  query: string;
  options?: SearchOptions;
  /**
   * scope==='currentTab' のとき検索対象タブを指定する。メインプロセスは「レンダラが現在
   * 選択しているタブ」を保持していないため、レンダラから明示的に渡す（developer 判断）。
   * scope==='all' のときは無視される。
   */
  tabId?: string;
}

export interface SearchHistoryAddArgs {
  query: string;
}

/**
 * `evt:indexUpdated` のペイロード（PLAN §2.7「検索インデックス更新（UI 側の再検索が必要な
 * 場合）」）。`tabId` 指定時はそのタブに影響する更新（保存・作成・リネーム・削除・複製・
 * 同一タブ内変換等）。複数タブにまたがる更新（タブ間移動/コピー）は影響する各タブ分だけ
 * 個別に送出する（developer 判断）。
 */
export interface IndexUpdatedPayload {
  tabId?: string;
}

// ---------------------------------------------------------------------------
// M4: ファイル監視（watch/watcher.ts）関連の型（PLAN §2.7、docs/milestones/M4-watch.md）。
// ---------------------------------------------------------------------------

/** `evt:externalChange` 1件分の変更内容（M4-watch.md「主に…」の表を実装レベルへ具体化）。 */
export interface ExternalChangeEntry {
  memoName: string;
  kind: 'add' | 'change' | 'unlink';
}

/**
 * `evt:externalChange` のペイロード（PLAN §2.7「外部変更を検知しツリー/本文に反映が必要」）。
 * `changes` はメタ JSON 自体の外部変更（ツリー再取得のみ促す）の場合は空配列になり得る。
 */
export interface ExternalChangePayload {
  tabId: string;
  changes: ExternalChangeEntry[];
}

/**
 * `evt:conflict` のペイロード（PLAN §2.7「編集中メモに外部変更（競合ダイアログを開く）」）。
 * 「編集中（未保存の変更がある）」対象メモに限定して発火する（DESIGN §3.3、
 * `editor:reportActive` で通知された dirty 状態を基に main/watch/watcher.ts が判定する）。
 */
export interface ConflictPayload {
  tabId: string;
  memoName: string;
}

/** `editor:reportActive` の引数（M4 新設、上記 `IpcChannels.editor.reportActive` の説明を参照）。 */
export interface EditorReportActiveArgs {
  active: {
    tabId: string;
    memoName: string;
    dirty: boolean;
    /**
     * 【2026-07-26追記・v3 M10b】現在開いているメモがMarkdown（`.md`由来）かどうか
     * （developer判断: 既存の dirty 通知と同じ経路に相乗りさせる。main側の右クリックメニュー
     * （main/index.ts の `context-menu` ハンドラ）が「文字色/太字/文字サイズ」項目を`.md`メモ
     * 編集時のみ追加するために必要、docs/v3/milestones/M10b-markdown-live-preview.md ゴール）。
     * `undefined`=不明（判定不能時は装飾メニューを出さない安全側）。
     */
    format?: 'plain' | 'markdown';
  } | null;
}

/**
 * `evt:opError` のペイロード（PLAN §2.7「リトライ後も失敗した I/O エラー等」）。M0 でチャネル名
 * のみ定義されていたが、ファイル監視（watch/watcher.ts）で初めてリクエスト/レスポンス型の
 * IPC 呼び出し元を持たないバックグラウンド I/O（chokidar イベント処理中の読込・インデックス
 * 更新）が発生するため、本 M4 で実装する。`Result` のエラー形と同じ `code`/`message`/`path?`
 * のみを運ぶ（00-core-principles.md §10 Fix8。内部情報はレンダラへ露出しない）。
 */
export interface OpErrorPayload {
  code: ErrorCode;
  message: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// M5: リンク機能（link:openExternal / link:resolveMemo）の引数/返却型（PLAN §2.5、
// docs/milestones/M5-links.md、DESIGN §2.8）。
// ---------------------------------------------------------------------------

/**
 * `link:openExternal` の対象種別。`memo:` 記法はアプリ内遷移のため対象外で
 * `link:resolveMemo` 側の専用チャネルを使う（DESIGN §2.8「memo: は外部起動を伴わない」）。
 */
export type LinkKind = 'url' | 'mailto' | 'path';

export interface LinkOpenExternalArgs {
  kind: LinkKind;
  /** レンダラで検出した元テキスト（例: `https://...`, `foo@example.com`, `C:\notes\a.txt`）。 */
  raw: string;
  /** 相対パス（`kind==='path'`）を解決する基準タブ（PLAN §2.5「baseTab の絶対パス基準で path.resolve」）。 */
  baseTabId?: string;
}

export interface LinkResolveMemoArgs {
  currentTabId: string;
  /** `memo:` プレフィックスを除いた本体（例: `メモ名` / `タブ名/メモ名` / `タブ名/`）。 */
  memoRef: string;
}

/**
 * `link:resolveMemo` の解決結果（data-model.md/PLAN §2.5 の表記は `{ tabId, memoName }`）。
 * `memoName` を省略可とした点は developer 判断（reviewer 確認事項）: DESIGN §2.8 の
 * `memo:タブ名/`（メモ指定なしでタブを開くだけ）記法を表現するため、メモ指定が無い解決結果は
 * `memoName` を省略する。メモ名まで指定された通常ケースでは必ず設定される。
 */
export interface LinkResolveMemoResult {
  tabId: string;
  memoName?: string;
}

// ---------------------------------------------------------------------------
// M6: パスワード暗号化（crypto:encryptMemo / decryptMemoToPlain / open / saveEncrypted /
// changePassword / lock）の引数/返却型（PLAN §2.4、docs/milestones/M6-crypto.md、DESIGN §2.9）。
// ---------------------------------------------------------------------------

export interface CryptoEncryptMemoArgs {
  tabId: string;
  memoName: string;
  password: string;
  /** 任意のパスワードヒント（`.txtenc` ヘッダに平文保存。UI 側で警告表示すること）。 */
  hint?: string;
}

export interface CryptoDecryptToPlainArgs {
  tabId: string;
  memoName: string;
  password: string;
}

export interface CryptoOpenArgs {
  tabId: string;
  memoName: string;
  password: string;
}

/**
 * `crypto:open` の返却型（`hash` は `.txtenc` ファイル全体のバイト列のハッシュ。次回保存の
 * 競合判定用, 00-core-principles.md §6）。
 */
export interface CryptoOpenResult {
  contentLF: string;
  eol: Eol;
  hash: string;
  /**
   * 【2026-07-26追記・v3 M10b前提】このメモがMarkdown（`.md`由来）かどうか（`.txtenc`ヘッダの
   * `format` 省略時は 'plain'）。M6個別暗号化を`crypto:open`で開封した場合、`TreeNode.format`は
   * 当該ノードが`encrypted:true`の間`undefined`のままのため、レンダラはこちらをローカル状態として
   * 保持しライブプレビュー判定に使う（docs/v3/milestones/M10b-markdown-live-preview.md §0.1/§0.7）。
   */
  format: 'plain' | 'markdown';
}

export interface CryptoSaveEncryptedArgs {
  tabId: string;
  memoName: string;
  contentLF: string;
  eol: Eol;
  expectedHash?: string;
}

export interface CryptoChangePasswordArgs {
  tabId: string;
  memoName: string;
  oldPassword: string;
  newPassword: string;
}

export interface CryptoLockArgs {
  tabId: string;
  memoName: string;
}

// ---------------------------------------------------------------------------
// v3 M8: ノード単位パスワードロック（crypto:lockNode / unlockNode / relockNode）の引数/返却型
// （docs/v3/DESIGNv3.md §1、docs/v3/PLANv3.md §2.1/§4、docs/v3/milestones/M8-node-lock-core.md）。
// v3 M9a で `lockContext`（ロック解除セッション配下での構造変更・入れ子ロック用引数, PLANv3 §2.2/§7.4、
// docs/v3/milestones/M9a-node-lock-session-ops.md）を追加した。
// ---------------------------------------------------------------------------

/**
 * v3 M9a: ロック解除セッションを指す共通引数（PLANv3 §1.4/§2.2）。`lockToken` は
 * `crypto:unlockNode` が返した値と同一（起点ノード自身の難読化ファイル名）。
 * `memo:read`/`memo:save`/`memo:create`/`memo:rename`/`memo:delete`/`memo:duplicate`/
 * `tree:updateStructure`/`crypto:lockNode`/`crypto:unlockNode` の各引数に任意項目として追加する。
 * 省略時は既存v1と完全に同じ挙動（タブ直下の可視ツリー・実ファイルが対象, PLANv3 §2.2）。
 */
export interface LockContext {
  lockToken: string;
}

export interface CryptoLockNodeArgs {
  tabId: string;
  /**
   * 対象ノード（`lockContext` 省略時は現在の可視ツリー上の memoName。指定時は対象セッションの
   * 実行時構造上の実名, 入れ子ロック, PLANv3 §7.4）。起点+配下全体がロック対象になる。
   */
  memoName: string;
  password: string;
  /** 任意のパスワードヒント（`lock.hint` に平文保存。UI 側で警告表示すること）。 */
  hint?: string;
  /** 指定時: 既に別ロックの解除セッション内にあるノードを起点にロックする（入れ子ロック）。 */
  lockContext?: LockContext;
}

export interface CryptoUnlockNodeArgs {
  tabId: string;
  /** ロック中ノード（難読化トークン）の memoName。 */
  memoName: string;
  password: string;
  /** 指定時: 既に別ロックの解除セッション内にあるノードを起点に解除する（入れ子ロック）。 */
  lockContext?: LockContext;
}

/** `crypto:unlockNode` の返却型。`tree` は起点ノード自身を含む単一要素配列（M8-node-lock-core.md §5.2）。 */
export interface CryptoUnlockNodeResult {
  lockToken: string;
  tree: TreeNode[];
}

export interface CryptoRelockNodeArgs {
  tabId: string;
  lockToken: string;
}

/**
 * v3 §1.14: `crypto:removeNodeLock`（ロックの恒久的解除, `docs/v3/DESIGNv3.md` §1.14）。
 * `memoName` は対象ロックの難読化トークン（`lockContext` 省略時はタブ直下のメタツリー上、
 * 指定時は親セッションの実行時構造上で解決する。`unlockNode` と同じ解決パターン）。
 * セッションの有無を問わず常に `password` から新規に鍵を導出する（セッション鍵の使い回しはしない,
 * M6 `crypto:decryptMemoToPlain` と同じ規律）。
 */
export interface CryptoRemoveNodeLockArgs {
  tabId: string;
  memoName: string;
  password: string;
  /** 指定時: 対象ロック自体が別ロックの解除セッション内にある（入れ子ロックの恒久解除）。 */
  lockContext?: LockContext;
}

/**
 * v3 M9c: `crypto:relockAllInTab`（タブ切替時のセッション一括破棄, docs/v3/DESIGNv3.md §1.11・
 * docs/v3/PLANv3.md §5.5/§7.6、docs/v3/milestones/M9c-node-lock-tab-switch.md）。
 * 対象タブに紐づく全ロックセッション（入れ子ロックの子セッション含む）を一括破棄する。
 */
export interface CryptoRelockAllInTabArgs {
  tabId: string;
}

// ---------------------------------------------------------------------------
// v3 M10a: Markdown保存形式基盤（`memo:convertFormat`）の引数/返却型
// （docs/v3/DESIGNv3.md §2.4/§2.5、docs/v3/PLANv3.md §2.3、
// docs/v3/milestones/M10a-markdown-format-core.md）。
// ---------------------------------------------------------------------------

export interface MemoConvertFormatArgs {
  tabId: string;
  memoName: string;
  targetFormat: 'txt' | 'md';
  /**
   * ロック解除セッション配下のメモは常に難読化名の `.txtenc` として保存され、`.txt`/`.md` の
   * 拡張子概念自体を持たない（DESIGNv3/PLANv3にセッションメンバー単位の format 追跡は定義が無く、
   * M10a は M8/M9 と独立スコープのため新設しない, developer 判断）。指定時はハンドラが
   * `NAME_INVALID` で明示的に拒否する（型としては milestone doc のシグネチャ通り受け付ける）。
   */
  lockContext?: LockContext;
}

/**
 * preload が `contextBridge.exposeInMainWorld('api', ...)` で公開する API の型。
 * M0 では `app:getInfo` のみだったが、M1 で tab/memo の基本チャネルと settings:get/set、
 * `evt:metaRecovered` 購読を追加した。M2 で tab.rename/remove/reorder、
 * memo.delete/duplicate/move、tree.updateStructure、`evt:trashFallback` 購読を追加した。
 * M6 で crypto.* 6 チャネルを追加した。
 * 以降の M でチャネル追加のたびにここへメソッドを追加し、preload 実装とレンダラ双方の型を
 * 同時に更新すること。
 */
export interface PreloadApi {
  app: {
    getInfo(): Promise<AppInfo>;
  };
  window: {
    /** 常時最前面表示のトグル（ユーザー要望）。 */
    setAlwaysOnTop(args: WindowSetAlwaysOnTopArgs): Promise<Result<void>>;
    /** Windowsログイン時の自動起動トグル（ユーザー要望）。 */
    setOpenAtLogin(args: WindowSetOpenAtLoginArgs): Promise<Result<void>>;
    /** 現在の自動起動設定（OSのレジストリ状態を反映）。 */
    getOpenAtLogin(): Promise<Result<boolean>>;
  };
  dialog: {
    /** フォルダ未選択（キャンセル）時は `Result<null>` を返す（エラーにしない）。 */
    pickFolder(args?: DialogPickFolderArgs): Promise<Result<string | null>>;
  };
  tab: {
    list(): Promise<Result<TabInfo[]>>;
    register(args: TabRegisterArgs): Promise<Result<TabInfo>>;
    create(args: TabCreateArgs): Promise<Result<TabInfo>>;
    openTree(args: TabOpenTreeArgs): Promise<Result<TreeSnapshot>>;
    rename(args: TabRenameArgs): Promise<Result<void>>;
    remove(args: TabRemoveArgs): Promise<Result<void>>;
    reorder(args: TabReorderArgs): Promise<Result<void>>;
    openFolder(args: TabOpenFolderArgs): Promise<Result<void>>;
  };
  memo: {
    read(args: MemoReadArgs): Promise<Result<MemoReadResult>>;
    readWithEncoding(args: MemoReadWithEncodingArgs): Promise<Result<MemoReadResult>>;
    save(args: MemoSaveArgs): Promise<Result<SaveResult>>;
    create(args: MemoCreateArgs): Promise<Result<MemoInfo>>;
    rename(args: MemoRenameArgs): Promise<Result<void>>;
    delete(args: MemoDeleteArgs): Promise<Result<void>>;
    duplicate(args: MemoDuplicateArgs): Promise<Result<MemoInfo>>;
    move(args: MemoMoveArgs): Promise<Result<void>>;
    getProperties(args: MemoGetPropertiesArgs): Promise<Result<MemoProperties>>;
    revealInFolder(args: MemoRevealInFolderArgs): Promise<Result<void>>;
    /** v3 M10a: `.txt`⇔`.md`変換（拡張子のみリネーム、本文は無変更）。 */
    convertFormat(args: MemoConvertFormatArgs): Promise<Result<MemoInfo>>;
  };
  tree: {
    updateStructure(args: TreeUpdateStructureArgs): Promise<Result<void>>;
  };
  search: {
    global(args: SearchGlobalArgs): Promise<Result<SearchHit[]>>;
    historyGet(): Promise<Result<string[]>>;
    historyAdd(args: SearchHistoryAddArgs): Promise<Result<void>>;
  };
  settings: {
    get(): Promise<Result<AppSettings>>;
    set(patch: AppSettingsPatch): Promise<Result<AppSettings>>;
  };
  editor: {
    /** 現在開いている(かつ未保存の変更があるか)状態をメインへ通知する（M4 新設）。 */
    reportActive(args: EditorReportActiveArgs): Promise<Result<void>>;
  };
  link: {
    /** URL/mailto/ファイルパスの外部起動（M5 新設, PLAN §2.5）。 */
    openExternal(args: LinkOpenExternalArgs): Promise<Result<void>>;
    /** `memo:` 記法の解決。解決不能時は `null`（エラーにしない, DESIGN §2.8）。 */
    resolveMemo(args: LinkResolveMemoArgs): Promise<Result<LinkResolveMemoResult | null>>;
  };
  crypto: {
    /** 平文 `.txt`→`.txtenc` 変換（M6 新設, DESIGN §2.9）。平文原本は直接削除。 */
    encryptMemo(args: CryptoEncryptMemoArgs): Promise<Result<MemoInfo>>;
    /** 明示的な暗号化解除。`.txtenc`→`.txt`（平文は通常扱い）。 */
    decryptMemoToPlain(args: CryptoDecryptToPlainArgs): Promise<Result<MemoInfo>>;
    /** 開封（復号）。成功時セッション鍵をメイン保持、本文平文をレンダラへ返す。 */
    open(args: CryptoOpenArgs): Promise<Result<CryptoOpenResult>>;
    /** 開封中メモの保存（`expectedHash` で外部変更競合検出、新 IV で再暗号化）。 */
    saveEncrypted(args: CryptoSaveEncryptedArgs): Promise<Result<SaveResult>>;
    /** 新 salt+新 IV で再暗号化する。 */
    changePassword(args: CryptoChangePasswordArgs): Promise<Result<void>>;
    /** セッション鍵破棄（再ロック）。 */
    lock(args: CryptoLockArgs): Promise<Result<void>>;
    /** v3 M8: サブツリーをロックする（起点+配下全体を難読化名+.txtenc化）。 */
    lockNode(args: CryptoLockNodeArgs): Promise<Result<void>>;
    /** v3 M8: ロック中サブツリーをパスワードで復号しセッション開始する。 */
    unlockNode(args: CryptoUnlockNodeArgs): Promise<Result<CryptoUnlockNodeResult>>;
    /** v3 M8: 単一ロックセッションの明示的破棄（ファイル操作なし）。 */
    relockNode(args: CryptoRelockNodeArgs): Promise<Result<void>>;
    /** v3 M9c: 指定タブに紐づく全ロックセッションを一括破棄（タブ切替時用、ファイル操作なし）。 */
    relockAllInTab(args: CryptoRelockAllInTabArgs): Promise<Result<void>>;
    /** v3 §1.14: ロックを恒久的に解除する（不可逆。`lockNode` と対称、`docs/v3/DESIGNv3.md` §1.14）。 */
    removeNodeLock(args: CryptoRemoveNodeLockArgs): Promise<Result<void>>;
  };
  events: {
    /** `evt:metaRecovered` を購読する。返り値の関数を呼ぶと購読解除する。 */
    onMetaRecovered(handler: (payload: MetaRecoveredPayload) => void): () => void;
    /** `evt:trashFallback` を購読する。返り値の関数を呼ぶと購読解除する。 */
    onTrashFallback(handler: (payload: TrashFallbackPayload) => void): () => void;
    /** `evt:indexUpdated` を購読する。返り値の関数を呼ぶと購読解除する。 */
    onIndexUpdated(handler: (payload: IndexUpdatedPayload) => void): () => void;
    /** `evt:externalChange` を購読する（M4）。返り値の関数を呼ぶと購読解除する。 */
    onExternalChange(handler: (payload: ExternalChangePayload) => void): () => void;
    /** `evt:conflict` を購読する（M4）。返り値の関数を呼ぶと購読解除する。 */
    onConflict(handler: (payload: ConflictPayload) => void): () => void;
    /** `evt:opError` を購読する（M4 で初実装）。返り値の関数を呼ぶと購読解除する。 */
    onOpError(handler: (payload: OpErrorPayload) => void): () => void;
    /** `evt:showProperties` を購読する（エディタ右クリック「プロパティ」, ユーザー要望）。 */
    onShowProperties(handler: (payload: ShowPropertiesPayload) => void): () => void;
    /** `evt:editorMenuCommand` を購読する（エディタ右クリックの各種コマンド, ユーザー要望）。 */
    onEditorMenuCommand(handler: (payload: EditorMenuCommandPayload) => void): () => void;
  };
}
