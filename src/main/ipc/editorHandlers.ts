// src/main/ipc/editorHandlers.ts
// `editor:reportActive` の IPC ハンドラ（M4 新設。docs/milestones/M4-watch.md の対象チャネル表には
// 明記が無いが、main/watch/activeMemoState.ts のコメントに記載の理由で追加した最小限のチャネル）。
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IpcChannels, type EditorReportActiveArgs } from '@shared/ipc-contract';
import type { Result } from '@shared/models';
import { ok, wrapHandler } from '../util/result';
import { setActiveMemoState } from '../watch/activeMemoState';

export function registerEditorHandlers(): void {
  ipcMain.handle(
    IpcChannels.editor.reportActive,
    wrapHandler((_event: IpcMainInvokeEvent, args: EditorReportActiveArgs): Result<void> => {
      setActiveMemoState(args.active);
      return ok(undefined);
    })
  );
}
