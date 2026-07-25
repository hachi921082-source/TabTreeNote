// src/main/ipc/windowHandlers.ts
// ウィンドウ操作の IPC ハンドラ（ユーザー要望: 常時最前面表示のトグル、Windowsログイン時の
// 自動起動トグル）。常時最前面はセッション内のみ（設定 JSON への永続化はしない, developer 判断）。
// 自動起動は Windows のレジストリ（スタートアップ登録）が真実源で、こちらも独自の永続化はしない。
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IpcChannels, type WindowSetAlwaysOnTopArgs, type WindowSetOpenAtLoginArgs } from '@shared/ipc-contract';
import type { Result } from '@shared/models';
import { loginItemExecPath } from '../fs/appDataRoot';
import { ok, wrapHandler } from '../util/result';

export function registerWindowHandlers(): void {
  ipcMain.handle(
    IpcChannels.window.setAlwaysOnTop,
    wrapHandler((event: IpcMainInvokeEvent, args: WindowSetAlwaysOnTopArgs): Result<void> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      win?.setAlwaysOnTop(args.enabled);
      return ok(undefined);
    })
  );

  ipcMain.handle(
    IpcChannels.window.setOpenAtLogin,
    wrapHandler((_event: IpcMainInvokeEvent, args: WindowSetOpenAtLoginArgs): Result<void> => {
      // トレイに隠れた状態で起動させる（`--hidden` を main/index.ts の起動判定で見る）。
      app.setLoginItemSettings({ openAtLogin: args.enabled, path: loginItemExecPath(), args: ['--hidden'] });
      return ok(undefined);
    })
  );

  ipcMain.handle(
    IpcChannels.window.getOpenAtLogin,
    wrapHandler((): Result<boolean> => ok(app.getLoginItemSettings().openAtLogin))
  );
}
