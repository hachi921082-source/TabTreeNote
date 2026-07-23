// src/main/ipc/searchHandlers.ts
// 検索の IPC ハンドラ（PLAN §2.3、docs/milestones/M3-search.md）。
// 現在メモ内検索・置換・正規表現・インクリメンタルはレンダラの CodeMirror 内で完結し IPC 不要
// （DESIGN §2.4）。本ファイルは全文検索（search:global）と検索履歴（search:history:get/add）のみ扱う。
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IpcChannels, type SearchGlobalArgs, type SearchHistoryAddArgs } from '@shared/ipc-contract';
import type { Result, SearchHit } from '@shared/models';
import { ok, wrapHandler } from '../util/result';
import { listTabs } from '../fs/tabService';
import { search } from '../search/searchIndex';

/** 保持する検索履歴の最大件数（developer 判断。仕様上の必須要件ではない）。 */
const SEARCH_HISTORY_LIMIT = 20;

/**
 * 検索履歴（`search:history:get`/`search:history:add`）はメインプロセスのメモリ内にのみ
 * 保持する（アプリ設定 JSON へは永続化しない）。data-model.md の AppSettings スキーマに
 * 検索履歴フィールドは定義されておらず、全文検索インデックス自体も「メモリ内軽量・永続DB
 * なし」方針（DESIGN §2.4）のため、履歴もセッション内メモリ保持に留める developer 判断。
 */
let searchHistory: string[] = [];

export function registerSearchHandlers(): void {
  ipcMain.handle(
    IpcChannels.search.global,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: SearchGlobalArgs): Promise<Result<SearchHit[]>> => {
      if (args.scope === 'currentTab' && !args.tabId) {
        return ok([]);
      }
      const hits = search(args.scope, args.tabId, args.query, args.options ?? {});
      const tabNames = new Map(listTabs().map((t) => [t.id, t.name]));
      const mapped: SearchHit[] = hits.map((h) => ({
        tabId: h.tabId,
        tabName: tabNames.get(h.tabId) ?? h.tabId,
        memoName: h.memoName,
        encrypted: h.encrypted,
        matchField: h.matchField,
        lineNumber: h.lineNumber,
        lineText: h.lineText,
        matchStart: h.matchStart,
        matchEnd: h.matchEnd
      }));
      return ok(mapped);
    })
  );

  ipcMain.handle(
    IpcChannels.search.historyGet,
    wrapHandler((): Result<string[]> => ok([...searchHistory]))
  );

  ipcMain.handle(
    IpcChannels.search.historyAdd,
    wrapHandler((_event: IpcMainInvokeEvent, args: SearchHistoryAddArgs): Result<void> => {
      const q = args.query.trim();
      if (q.length === 0) return ok(undefined);
      searchHistory = [q, ...searchHistory.filter((h) => h !== q)].slice(0, SEARCH_HISTORY_LIMIT);
      return ok(undefined);
    })
  );
}
