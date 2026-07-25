// src/main/ipc/dialogHandlers.ts
// ネイティブのフォルダ選択ダイアログ（`dialog:pickFolder`）。
// `window.prompt()` は Electron のレンダラープロセスでは動作しない（何も表示せず即 `null` を
// 返す）ため、タブ登録/新規タブ作成での絶対パス手入力の代替として OS のフォルダ選択 UI を提供する。
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IpcChannels, type DialogPickFolderArgs } from '@shared/ipc-contract';
import type { Result } from '@shared/models';
import { ok, wrapHandler } from '../util/result';

export function registerDialogHandlers(): void {
  ipcMain.handle(
    IpcChannels.dialog.pickFolder,
    wrapHandler(
      async (event: IpcMainInvokeEvent, args?: DialogPickFolderArgs): Promise<Result<string | null>> => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const options = { properties: ['openDirectory' as const], defaultPath: args?.defaultPath };
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) return ok(null);
        return ok(result.filePaths[0] ?? null);
      }
    )
  );
}
