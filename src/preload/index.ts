// src/preload/index.ts
// contextBridge で window.api（型: PreloadApi）を公開する。
// 公開するのは IPC チャネルをラップした関数群と通知購読関数のみ。
// `ipcRenderer` 生オブジェクトや `require`/Node API は一切露出しない
// (docs/00-core-principles.md §10 セキュリティ不変条件)。
import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannels,
  IpcEvents,
  type AppInfo,
  type ConflictPayload,
  type CryptoChangePasswordArgs,
  type CryptoDecryptToPlainArgs,
  type CryptoEncryptMemoArgs,
  type CryptoLockArgs,
  type CryptoLockNodeArgs,
  type CryptoOpenArgs,
  type CryptoOpenResult,
  type CryptoRelockAllInTabArgs,
  type CryptoRelockNodeArgs,
  type CryptoSaveEncryptedArgs,
  type CryptoUnlockNodeArgs,
  type CryptoUnlockNodeResult,
  type DialogPickFolderArgs,
  type EditorMenuCommandPayload,
  type EditorReportActiveArgs,
  type ExternalChangePayload,
  type IndexUpdatedPayload,
  type LinkOpenExternalArgs,
  type LinkResolveMemoArgs,
  type LinkResolveMemoResult,
  type MemoConvertFormatArgs,
  type MemoCreateArgs,
  type MemoDeleteArgs,
  type MemoDuplicateArgs,
  type MemoGetPropertiesArgs,
  type MemoMoveArgs,
  type MemoProperties,
  type MemoReadArgs,
  type MemoReadWithEncodingArgs,
  type MemoRenameArgs,
  type MemoRevealInFolderArgs,
  type MemoSaveArgs,
  type MetaRecoveredPayload,
  type OpErrorPayload,
  type PreloadApi,
  type SearchGlobalArgs,
  type SearchHistoryAddArgs,
  type ShowPropertiesPayload,
  type TabCreateArgs,
  type TabOpenFolderArgs,
  type TabOpenTreeArgs,
  type TabRegisterArgs,
  type TabRemoveArgs,
  type TabRenameArgs,
  type TabReorderArgs,
  type TrashFallbackPayload,
  type TreeUpdateStructureArgs,
  type WindowSetAlwaysOnTopArgs,
  type WindowSetOpenAtLoginArgs
} from '@shared/ipc-contract';
import type {
  AppSettingsPatch,
  MemoInfo,
  MemoReadResult,
  Result,
  SaveResult,
  SearchHit,
  TabInfo,
  TreeSnapshot,
  AppSettings
} from '@shared/models';

const api: PreloadApi = {
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannels.app.getInfo)
  },
  window: {
    setAlwaysOnTop: (args: WindowSetAlwaysOnTopArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.window.setAlwaysOnTop, args),
    setOpenAtLogin: (args: WindowSetOpenAtLoginArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.window.setOpenAtLogin, args),
    getOpenAtLogin: (): Promise<Result<boolean>> => ipcRenderer.invoke(IpcChannels.window.getOpenAtLogin)
  },
  dialog: {
    pickFolder: (args?: DialogPickFolderArgs): Promise<Result<string | null>> =>
      ipcRenderer.invoke(IpcChannels.dialog.pickFolder, args)
  },
  tab: {
    list: (): Promise<Result<TabInfo[]>> => ipcRenderer.invoke(IpcChannels.tab.list),
    register: (args: TabRegisterArgs): Promise<Result<TabInfo>> => ipcRenderer.invoke(IpcChannels.tab.register, args),
    create: (args: TabCreateArgs): Promise<Result<TabInfo>> => ipcRenderer.invoke(IpcChannels.tab.create, args),
    openTree: (args: TabOpenTreeArgs): Promise<Result<TreeSnapshot>> =>
      ipcRenderer.invoke(IpcChannels.tab.openTree, args),
    rename: (args: TabRenameArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.tab.rename, args),
    remove: (args: TabRemoveArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.tab.remove, args),
    reorder: (args: TabReorderArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.tab.reorder, args),
    openFolder: (args: TabOpenFolderArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.tab.openFolder, args)
  },
  memo: {
    read: (args: MemoReadArgs): Promise<Result<MemoReadResult>> => ipcRenderer.invoke(IpcChannels.memo.read, args),
    readWithEncoding: (args: MemoReadWithEncodingArgs): Promise<Result<MemoReadResult>> =>
      ipcRenderer.invoke(IpcChannels.memo.readWithEncoding, args),
    save: (args: MemoSaveArgs): Promise<Result<SaveResult>> => ipcRenderer.invoke(IpcChannels.memo.save, args),
    create: (args: MemoCreateArgs): Promise<Result<MemoInfo>> => ipcRenderer.invoke(IpcChannels.memo.create, args),
    rename: (args: MemoRenameArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.memo.rename, args),
    delete: (args: MemoDeleteArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.memo.delete, args),
    duplicate: (args: MemoDuplicateArgs): Promise<Result<MemoInfo>> =>
      ipcRenderer.invoke(IpcChannels.memo.duplicate, args),
    move: (args: MemoMoveArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.memo.move, args),
    getProperties: (args: MemoGetPropertiesArgs): Promise<Result<MemoProperties>> =>
      ipcRenderer.invoke(IpcChannels.memo.getProperties, args),
    revealInFolder: (args: MemoRevealInFolderArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.memo.revealInFolder, args),
    convertFormat: (args: MemoConvertFormatArgs): Promise<Result<MemoInfo>> =>
      ipcRenderer.invoke(IpcChannels.memo.convertFormat, args)
  },
  tree: {
    updateStructure: (args: TreeUpdateStructureArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.tree.updateStructure, args)
  },
  search: {
    global: (args: SearchGlobalArgs): Promise<Result<SearchHit[]>> => ipcRenderer.invoke(IpcChannels.search.global, args),
    historyGet: (): Promise<Result<string[]>> => ipcRenderer.invoke(IpcChannels.search.historyGet),
    historyAdd: (args: SearchHistoryAddArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.search.historyAdd, args)
  },
  settings: {
    get: (): Promise<Result<AppSettings>> => ipcRenderer.invoke(IpcChannels.settings.get),
    set: (patch: AppSettingsPatch): Promise<Result<AppSettings>> => ipcRenderer.invoke(IpcChannels.settings.set, patch)
  },
  editor: {
    reportActive: (args: EditorReportActiveArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.editor.reportActive, args)
  },
  link: {
    openExternal: (args: LinkOpenExternalArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.link.openExternal, args),
    resolveMemo: (args: LinkResolveMemoArgs): Promise<Result<LinkResolveMemoResult | null>> =>
      ipcRenderer.invoke(IpcChannels.link.resolveMemo, args)
  },
  crypto: {
    encryptMemo: (args: CryptoEncryptMemoArgs): Promise<Result<MemoInfo>> =>
      ipcRenderer.invoke(IpcChannels.crypto.encryptMemo, args),
    decryptMemoToPlain: (args: CryptoDecryptToPlainArgs): Promise<Result<MemoInfo>> =>
      ipcRenderer.invoke(IpcChannels.crypto.decryptMemoToPlain, args),
    open: (args: CryptoOpenArgs): Promise<Result<CryptoOpenResult>> => ipcRenderer.invoke(IpcChannels.crypto.open, args),
    saveEncrypted: (args: CryptoSaveEncryptedArgs): Promise<Result<SaveResult>> =>
      ipcRenderer.invoke(IpcChannels.crypto.saveEncrypted, args),
    changePassword: (args: CryptoChangePasswordArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.crypto.changePassword, args),
    lock: (args: CryptoLockArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.crypto.lock, args),
    lockNode: (args: CryptoLockNodeArgs): Promise<Result<void>> => ipcRenderer.invoke(IpcChannels.crypto.lockNode, args),
    unlockNode: (args: CryptoUnlockNodeArgs): Promise<Result<CryptoUnlockNodeResult>> =>
      ipcRenderer.invoke(IpcChannels.crypto.unlockNode, args),
    relockNode: (args: CryptoRelockNodeArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.crypto.relockNode, args),
    relockAllInTab: (args: CryptoRelockAllInTabArgs): Promise<Result<void>> =>
      ipcRenderer.invoke(IpcChannels.crypto.relockAllInTab, args)
  },
  events: {
    onMetaRecovered: (handler: (payload: MetaRecoveredPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: MetaRecoveredPayload): void => handler(payload);
      ipcRenderer.on(IpcEvents.metaRecovered, listener);
      return () => ipcRenderer.removeListener(IpcEvents.metaRecovered, listener);
    },
    onTrashFallback: (handler: (payload: TrashFallbackPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TrashFallbackPayload): void => handler(payload);
      ipcRenderer.on(IpcEvents.trashFallback, listener);
      return () => ipcRenderer.removeListener(IpcEvents.trashFallback, listener);
    },
    onIndexUpdated: (handler: (payload: IndexUpdatedPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: IndexUpdatedPayload): void => handler(payload);
      ipcRenderer.on(IpcEvents.indexUpdated, listener);
      return () => ipcRenderer.removeListener(IpcEvents.indexUpdated, listener);
    },
    onExternalChange: (handler: (payload: ExternalChangePayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ExternalChangePayload): void => handler(payload);
      ipcRenderer.on(IpcEvents.externalChange, listener);
      return () => ipcRenderer.removeListener(IpcEvents.externalChange, listener);
    },
    onConflict: (handler: (payload: ConflictPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ConflictPayload): void => handler(payload);
      ipcRenderer.on(IpcEvents.conflict, listener);
      return () => ipcRenderer.removeListener(IpcEvents.conflict, listener);
    },
    onOpError: (handler: (payload: OpErrorPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: OpErrorPayload): void => handler(payload);
      ipcRenderer.on(IpcEvents.opError, listener);
      return () => ipcRenderer.removeListener(IpcEvents.opError, listener);
    },
    onShowProperties: (handler: (payload: ShowPropertiesPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ShowPropertiesPayload): void => handler(payload);
      ipcRenderer.on(IpcEvents.showProperties, listener);
      return () => ipcRenderer.removeListener(IpcEvents.showProperties, listener);
    },
    onEditorMenuCommand: (handler: (payload: EditorMenuCommandPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: EditorMenuCommandPayload): void => handler(payload);
      ipcRenderer.on(IpcEvents.editorMenuCommand, listener);
      return () => ipcRenderer.removeListener(IpcEvents.editorMenuCommand, listener);
    }
  }
};

contextBridge.exposeInMainWorld('api', api);
