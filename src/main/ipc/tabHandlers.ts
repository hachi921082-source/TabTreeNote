// src/main/ipc/tabHandlers.ts
// タブ（管理フォルダ）操作の IPC ハンドラ（PLAN §2.1）。M1 で list/register/create/openTree。
// M2 で tab:rename/remove/reorder を追加した（docs/milestones/M2-tree-ui.md）。
// M3 で tab:register/create/remove の完了点から全文検索インデックス経路①を配線した
// （docs/milestones/M3-search.md）。tab:rename はフォルダの物理パスが変わるだけで tabId・
// メモ名は不変（インデックスは tabId をキーにするため）なので更新不要。
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  IpcChannels,
  IpcEvents,
  type IndexUpdatedPayload,
  type MetaRecoveredPayload,
  type TabOpenFolderArgs,
  type TabRemoveArgs,
  type TabRenameArgs,
  type TabReorderArgs
} from '@shared/ipc-contract';
import type { Result, TabInfo, TreeSnapshot } from '@shared/models';
import { err, ok, wrapHandler } from '../util/result';
import { createTab, getTabFolderPath, listTabs, openTabTree, registerTab, removeTab, renameTab, reorderTabs } from '../fs/tabService';
import { indexTab, removeTabFromIndex } from '../search/searchIndex';
import { addWatchedTab, removeWatchedTab, renameWatchedTab } from '../watch/watcher';

export function registerTabHandlers(): void {
  ipcMain.handle(
    IpcChannels.tab.list,
    wrapHandler((): Promise<Result<TabInfo[]>> | Result<TabInfo[]> => ok(listTabs()))
  );

  ipcMain.handle(
    IpcChannels.tab.register,
    wrapHandler(async (event: IpcMainInvokeEvent, args: { folderPath: string }): Promise<Result<TabInfo>> => {
      const result = await registerTab(args.folderPath);
      if (result.ok) {
        // 既存フォルダの登録は既存メモを含み得るため、インデックスへ (再)走査して反映する。
        await indexTab(result.value.id, result.value.folderPath);
        const payload: IndexUpdatedPayload = { tabId: result.value.id };
        event.sender.send(IpcEvents.indexUpdated, payload);
        // ファイル監視対象へ追加する（M4）。
        addWatchedTab(result.value.id, result.value.folderPath);
      }
      return result;
    })
  );

  ipcMain.handle(
    IpcChannels.tab.create,
    wrapHandler(
      async (event: IpcMainInvokeEvent, args: { parentDir?: string; name: string }): Promise<Result<TabInfo>> => {
        const result = await createTab(args.parentDir, args.name);
        if (result.ok) {
          // 新規フォルダは通常空だが、走査を経路①の唯一の入口として一貫させる。
          await indexTab(result.value.id, result.value.folderPath);
          const payload: IndexUpdatedPayload = { tabId: result.value.id };
          event.sender.send(IpcEvents.indexUpdated, payload);
          // ファイル監視対象へ追加する（M4）。
          addWatchedTab(result.value.id, result.value.folderPath);
        }
        return result;
      }
    )
  );

  ipcMain.handle(
    IpcChannels.tab.openTree,
    wrapHandler((event: IpcMainInvokeEvent, args: { tabId: string }): Promise<Result<TreeSnapshot>> =>
      openTabTree(args.tabId, (message) => {
        const payload: MetaRecoveredPayload = { message, tabId: args.tabId };
        event.sender.send(IpcEvents.metaRecovered, payload);
      })
    )
  );

  ipcMain.handle(
    IpcChannels.tab.rename,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: TabRenameArgs): Promise<Result<void>> => {
      const result = await renameTab(args.tabId, args.newName);
      if (result.ok) {
        // フォルダの物理パスが変わったため、監視対象も新パスへ切り替える（M4）。
        const folder = getTabFolderPath(args.tabId);
        if (folder.ok) renameWatchedTab(args.tabId, folder.value);
      }
      return result;
    })
  );

  ipcMain.handle(
    IpcChannels.tab.remove,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: TabRemoveArgs): Promise<Result<void>> => {
      const result = await removeTab(args.tabId, args.deleteFolder ?? false);
      if (result.ok) {
        // タブ登録解除に伴い、インデックスからも当該タブ分を除去する（indexUpdated 通知は
        // 対象タブが UI から既に切り離されるため不要。renderer 側は tab:list 再取得で追従する）。
        removeTabFromIndex(args.tabId);
        // ファイル監視対象からも除去する（M4）。
        removeWatchedTab(args.tabId);
      }
      return result;
    })
  );

  ipcMain.handle(
    IpcChannels.tab.reorder,
    wrapHandler(
      (_event: IpcMainInvokeEvent, args: TabReorderArgs): Promise<Result<void>> => reorderTabs(args.orderedTabIds)
    )
  );

  ipcMain.handle(
    IpcChannels.tab.openFolder,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: TabOpenFolderArgs): Promise<Result<void>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const openError = await shell.openPath(folder.value);
      if (openError) return err('NOT_FOUND', `開けませんでした: ${openError}`, folder.value);
      return ok(undefined);
    })
  );
}
