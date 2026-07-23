// src/main/ipc/settingsHandlers.ts
// アプリ設定 JSON の IPC ハンドラ（`settings:get`/`settings:set`, PLAN §3）。
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IpcChannels } from '@shared/ipc-contract';
import type { AppSettings, AppSettingsPatch, Result } from '@shared/models';
import { ok, wrapHandler } from '../util/result';
import { getAppSettings, patchAppSettings } from '../settings/appSettings';

export function registerSettingsHandlers(): void {
  ipcMain.handle(
    IpcChannels.settings.get,
    wrapHandler((): Result<AppSettings> => ok(getAppSettings()))
  );

  ipcMain.handle(
    IpcChannels.settings.set,
    wrapHandler(
      async (_event: IpcMainInvokeEvent, patch: AppSettingsPatch): Promise<Result<AppSettings>> =>
        ok(await patchAppSettings(patch))
    )
  );
}
