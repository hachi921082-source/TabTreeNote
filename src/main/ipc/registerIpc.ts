// src/main/ipc/registerIpc.ts
// 全 ipcMain.handle 登録の集約（PLAN.md §3）。
// M0 では `app:getInfo` のみだったが、M1 で tabHandlers / memoHandlers / settingsHandlers を、
// M3 で searchHandlers を、M5 で linkHandlers を追加した。cryptoHandlers は以降の M で追加する。
import { app, ipcMain } from 'electron';
import { IpcChannels, type AppInfo } from '@shared/ipc-contract';
import { SCHEMA_VERSION } from '@shared/constants';
import { registerTabHandlers } from './tabHandlers';
import { registerMemoHandlers } from './memoHandlers';
import { registerSearchHandlers } from './searchHandlers';
import { registerSettingsHandlers } from './settingsHandlers';
import { registerEditorHandlers } from './editorHandlers';
import { registerLinkHandlers } from './linkHandlers';

export function registerIpc(): void {
  ipcMain.handle(IpcChannels.app.getInfo, (): AppInfo => {
    return { appVersion: app.getVersion(), schemaVersion: SCHEMA_VERSION };
  });

  registerTabHandlers();
  registerMemoHandlers();
  registerSearchHandlers();
  registerSettingsHandlers();
  registerEditorHandlers();
  registerLinkHandlers();
}
