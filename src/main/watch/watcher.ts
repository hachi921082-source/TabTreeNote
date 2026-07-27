// src/main/watch/watcher.ts
// chokidar 起動・`ignored`・デバウンス・自己発火除外・競合判定振り分け・経路②インデックス更新
// （docs/milestones/M4-watch.md、PLAN §5.6、DESIGN §3.3/§2.4）。
//
// 監視対象は登録タブフォルダの直下のみ（`depth: 0`。サブフォルダは対象外, DESIGN §2.2 と同じ
// 走査範囲）。`ignored` は一時ファイルプレフィックス・`.bak` サフィックス・Windows OS 生成
// ファイル（desktop.ini/Thumbs.db, Fix10）を除外する。
//
// 処理の流れ（PLAN §5.6）:
//   1. chokidar が add/change/unlink を発火。
//   2. パスごとにデバウンス（既定 200ms）で集約し、最後に確定したイベント種別のみ処理する。
//   3. 自己発火判定（watch/conflict.ts の isSelfWriteEvent）で自己書き込みなら破棄
//      （経路①で既にインデックス反映済みのため何もしない）。
//   4. 外部変更と判定した場合: 経路②でインデックス更新 → 「編集中(未保存の変更あり)」な
//      対象メモなら `evt:conflict`、そうでなければ `evt:externalChange` をレンダラへ送る。
import { watch, type FSWatcher } from 'chokidar';
import { basename, dirname, resolve } from 'node:path';
import {
  BACKUP_SUFFIX,
  META_FILE_NAME,
  MEMO_EXT_ENCRYPTED,
  MEMO_EXT_MARKDOWN,
  MEMO_EXT_PLAIN,
  OS_JUNK_FILE_NAMES,
  TEMP_FILE_PREFIX,
  WATCH_DEBOUNCE_MS
} from '@shared/constants';
import {
  IpcEvents,
  type ConflictPayload,
  type ExternalChangePayload,
  type IndexUpdatedPayload,
  type OpErrorPayload
} from '@shared/ipc-contract';
import { readMemo } from '../fs/memoFileService';
import { removeMemo as removeMemoFromIndex, updateMemo as updateMemoIndex } from '../search/searchIndex';
import { getActiveMemoState } from './activeMemoState';
import { isSelfWriteEvent } from './conflict';

/** `startWatching` に渡すタブ 1 件分の情報。 */
export interface WatchTabRef {
  tabId: string;
  folderPath: string;
}

type RawEventType = 'add' | 'change' | 'unlink';

/** レンダラへイベントを送るための最小インターフェース（`BrowserWindow.webContents` 互換）。 */
export interface EventSink {
  send(channel: string, payload: unknown): void;
}

const watchedTabFolders = new Map<string, string>(); // tabId -> 解決済み絶対パス
const pendingByPath = new Map<string, { type: RawEventType; timer: NodeJS.Timeout }>();

let watcher: FSWatcher | null = null;
let sink: EventSink | null = null;

/** temp/`.bak`/Windows OS 生成ファイルを監視除外する（Fix10）。 */
function isIgnoredPath(path: string): boolean {
  const base = basename(path);
  if (base.startsWith(TEMP_FILE_PREFIX)) return true;
  if (base.endsWith(BACKUP_SUFFIX)) return true;
  return OS_JUNK_FILE_NAMES.has(base.toLowerCase());
}

/** イベントパスの直上フォルダから、対応する登録タブを逆引きする（直下のみ, DESIGN §2.2）。 */
function findOwningTab(path: string): WatchTabRef | null {
  const dir = resolve(dirname(path));
  for (const [tabId, folderPath] of watchedTabFolders) {
    if (folderPath === dir) return { tabId, folderPath };
  }
  return null;
}

function emit<T>(channel: string, payload: T): void {
  sink?.send(channel, payload);
}

/**
 * デバウンス確定後のイベント処理本体。`scheduleDebounced` からは必ず `safeProcessSettledEvent`
 * 経由で呼ぶこと（例外を捕捉して `evt:opError` へ丸めるため。捕捉しないと `setTimeout` コールバック
 * 内の未処理 Promise 拒否となり、長時間稼働するメインプロセスの安定性を損ないかねない）。
 */
async function processSettledEvent(path: string, type: RawEventType): Promise<void> {
  if (await isSelfWriteEvent(path)) return; // 自己発火（経路①で既に反映済み）として破棄。

  const owner = findOwningTab(path);
  if (!owner) return; // 監視解除済み等、既に無効なタブ。

  const base = basename(path);

  if (base === META_FILE_NAME) {
    // メタ JSON の外部変更（手動編集等の稀なケース）はツリー再取得のみ促す。
    // metaStore の読込側が破損時の復旧カスケードを担うため、ここでは反映指示のみでよい。
    emit<ExternalChangePayload>(IpcEvents.externalChange, { tabId: owner.tabId, changes: [] });
    return;
  }

  let memoName: string;
  let encrypted: boolean;
  // 【v3 M10a】`.md` も `.txt` と並ぶ「平文相当」の第三拡張子として認識する（scanTabFolder と
  // 同じ対象範囲。未対応のままだと外部エディタ等での `.md` 編集がインデックス/競合判定に
  // 一切反映されず、`.txt` と「全く同様に動作する」というM10aのゴールを満たさなくなる）。
  let format: 'plain' | 'markdown' = 'plain';
  if (base.endsWith(MEMO_EXT_ENCRYPTED)) {
    memoName = base.slice(0, -MEMO_EXT_ENCRYPTED.length);
    encrypted = true;
  } else if (base.endsWith(MEMO_EXT_MARKDOWN)) {
    memoName = base.slice(0, -MEMO_EXT_MARKDOWN.length);
    encrypted = false;
    format = 'markdown';
  } else if (base.endsWith(MEMO_EXT_PLAIN)) {
    memoName = base.slice(0, -MEMO_EXT_PLAIN.length);
    encrypted = false;
  } else {
    return; // メモ/メタ以外の無関係なファイルは対象外（scanTabFolder と同じ対象範囲）。
  }

  // インデックス経路②（外部からの変更のみ, DESIGN §2.4）。
  if (type === 'unlink') {
    removeMemoFromIndex(owner.tabId, memoName);
  } else if (encrypted) {
    updateMemoIndex(owner.tabId, memoName, true, null);
  } else {
    const res = await readMemo(owner.folderPath, memoName);
    updateMemoIndex(owner.tabId, memoName, false, res.ok ? res.value.contentLF : '', format);
  }
  emit<IndexUpdatedPayload>(IpcEvents.indexUpdated, { tabId: owner.tabId });

  const active = getActiveMemoState();
  if (active && active.tabId === owner.tabId && active.memoName === memoName && active.dirty) {
    // 編集中（未保存の変更あり）のメモへの外部変更 → 競合ダイアログ（DESIGN §3.3）。
    emit<ConflictPayload>(IpcEvents.conflict, { tabId: owner.tabId, memoName });
    return;
  }

  emit<ExternalChangePayload>(IpcEvents.externalChange, {
    tabId: owner.tabId,
    changes: [{ memoName, kind: type }]
  });
}

/**
 * `processSettledEvent` を例外安全に実行する（00-core-principles.md §8「予期せぬ例外」/ §10
 * Fix8）。捕捉した例外は元情報をメインプロセス内部ログにのみ記録し、レンダラへは
 * `evt:opError` で `code`/`message`/`path` のみを通知する（内部情報は露出しない）。
 */
async function safeProcessSettledEvent(path: string, type: RawEventType): Promise<void> {
  try {
    await processSettledEvent(path, type);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // eslint-disable-next-line no-console -- 内部診断ログ（レンダラへは渡さない, Fix8）
    console.error('[main] watcher: failed to process fs event', path, type, {
      name: error.name,
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
      stack: error.stack
    });
    emit<OpErrorPayload>(IpcEvents.opError, {
      code: 'UNKNOWN',
      message: 'ファイル監視イベントの処理に失敗しました。',
      path
    });
  }
}

/** 同一パスへの連続イベントをデバウンスで集約し、最後に確定した種別のみ処理する（PLAN §5.6）。 */
function scheduleDebounced(path: string, type: RawEventType): void {
  const existing = pendingByPath.get(path);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingByPath.delete(path);
    void safeProcessSettledEvent(path, type);
  }, WATCH_DEBOUNCE_MS);
  timer.unref?.();
  pendingByPath.set(path, { type, timer });
}

function ensureWatcher(): FSWatcher {
  if (watcher) return watcher;
  const w = watch([], {
    depth: 0,
    ignoreInitial: true,
    ignored: isIgnoredPath,
    persistent: true
  });
  w.on('add', (path: string) => scheduleDebounced(path, 'add'));
  w.on('change', (path: string) => scheduleDebounced(path, 'change'));
  w.on('unlink', (path: string) => scheduleDebounced(path, 'unlink'));
  w.on('error', (error: unknown) => {
    // 内部診断ログ（00-core-principles.md §10 Fix8）。
    // eslint-disable-next-line no-console -- 内部診断ログ
    console.error('[main] chokidar watcher error', error);
    emit<OpErrorPayload>(IpcEvents.opError, { code: 'UNKNOWN', message: 'ファイル監視でエラーが発生しました。' });
  });
  watcher = w;
  return w;
}

/** アプリ起動時、ウィンドウ生成後に一度だけ呼ぶ（登録済み全タブフォルダの監視を開始する）。 */
export function startWatching(eventSink: EventSink, tabs: readonly WatchTabRef[]): void {
  sink = eventSink;
  const w = ensureWatcher();
  for (const tab of tabs) {
    const resolved = resolve(tab.folderPath);
    watchedTabFolders.set(tab.tabId, resolved);
    w.add(resolved);
  }
}

/** タブ登録/作成成功直後に呼ぶ（新規フォルダを監視対象へ追加する）。 */
export function addWatchedTab(tabId: string, folderPath: string): void {
  const resolved = resolve(folderPath);
  watchedTabFolders.set(tabId, resolved);
  ensureWatcher().add(resolved);
}

/** タブ登録解除成功直後に呼ぶ。 */
export function removeWatchedTab(tabId: string): void {
  const folderPath = watchedTabFolders.get(tabId);
  if (!folderPath) return;
  watchedTabFolders.delete(tabId);
  watcher?.unwatch(folderPath);
}

/** タブフォルダのリネーム成功直後に呼ぶ（旧パスの監視を解除し新パスを監視する）。 */
export function renameWatchedTab(tabId: string, newFolderPath: string): void {
  const oldFolderPath = watchedTabFolders.get(tabId);
  if (oldFolderPath) watcher?.unwatch(oldFolderPath);
  const resolved = resolve(newFolderPath);
  watchedTabFolders.set(tabId, resolved);
  ensureWatcher().add(resolved);
}

/** アプリ終了時のクリーンアップ（プロセス終了で自然に破棄されるが明示的に閉じておく）。 */
export async function stopWatching(): Promise<void> {
  for (const pending of pendingByPath.values()) clearTimeout(pending.timer);
  pendingByPath.clear();
  await watcher?.close();
  watcher = null;
  watchedTabFolders.clear();
  sink = null;
}
