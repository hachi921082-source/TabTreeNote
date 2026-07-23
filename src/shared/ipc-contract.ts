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
  MemoInfo,
  MemoReadResult,
  MetaTreeNode,
  Result,
  SaveResult,
  SearchHit,
  TabInfo,
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
    openTree: 'tab:openTree'
  },
  memo: {
    read: 'memo:read',
    readWithEncoding: 'memo:readWithEncoding',
    save: 'memo:save',
    create: 'memo:create',
    rename: 'memo:rename',
    delete: 'memo:delete',
    duplicate: 'memo:duplicate',
    move: 'memo:move'
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
    lock: 'crypto:lock'
  },
  link: {
    openExternal: 'link:openExternal',
    resolveMemo: 'link:resolveMemo'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set'
  },
  app: {
    getInfo: 'app:getInfo'
  }
} as const;

/** メイン→レンダラの一方向イベント（`webContents.send` + preload 購読関数, PLAN §2.7）。 */
export const IpcEvents = {
  externalChange: 'evt:externalChange',
  conflict: 'evt:conflict',
  indexUpdated: 'evt:indexUpdated',
  metaRecovered: 'evt:metaRecovered',
  trashFallback: 'evt:trashFallback',
  opError: 'evt:opError'
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

export interface TabCreateArgs {
  parentDir: string;
  name: string;
}

export interface TabOpenTreeArgs {
  tabId: string;
}

export interface MemoReadArgs {
  tabId: string;
  memoName: string;
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
}

export interface MemoCreateArgs {
  tabId: string;
  name: string;
  position: AddPosition;
  anchorMemoName?: string;
}

export interface MemoRenameArgs {
  tabId: string;
  oldName: string;
  newName: string;
}

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
}

export interface MemoDuplicateArgs {
  tabId: string;
  memoName: string;
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
}

export interface TreeUpdateStructureArgs {
  tabId: string;
  /** 新しいツリー構造全体（並び順・階層・開閉・ラベルを含む）。実ファイル集合と厳密一致すること。 */
  treeStructure: MetaTreeNode[];
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

/**
 * preload が `contextBridge.exposeInMainWorld('api', ...)` で公開する API の型。
 * M0 では `app:getInfo` のみだったが、M1 で tab/memo の基本チャネルと settings:get/set、
 * `evt:metaRecovered` 購読を追加した。M2 で tab.rename/remove/reorder、
 * memo.delete/duplicate/move、tree.updateStructure、`evt:trashFallback` 購読を追加した。
 * 以降の M でチャネル追加のたびにここへメソッドを追加し、preload 実装とレンダラ双方の型を
 * 同時に更新すること。
 */
export interface PreloadApi {
  app: {
    getInfo(): Promise<AppInfo>;
  };
  tab: {
    list(): Promise<Result<TabInfo[]>>;
    register(args: TabRegisterArgs): Promise<Result<TabInfo>>;
    create(args: TabCreateArgs): Promise<Result<TabInfo>>;
    openTree(args: TabOpenTreeArgs): Promise<Result<TreeSnapshot>>;
    rename(args: TabRenameArgs): Promise<Result<void>>;
    remove(args: TabRemoveArgs): Promise<Result<void>>;
    reorder(args: TabReorderArgs): Promise<Result<void>>;
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
  events: {
    /** `evt:metaRecovered` を購読する。返り値の関数を呼ぶと購読解除する。 */
    onMetaRecovered(handler: (payload: MetaRecoveredPayload) => void): () => void;
    /** `evt:trashFallback` を購読する。返り値の関数を呼ぶと購読解除する。 */
    onTrashFallback(handler: (payload: TrashFallbackPayload) => void): () => void;
    /** `evt:indexUpdated` を購読する。返り値の関数を呼ぶと購読解除する。 */
    onIndexUpdated(handler: (payload: IndexUpdatedPayload) => void): () => void;
  };
}
