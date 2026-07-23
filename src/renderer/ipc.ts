// src/renderer/ipc.ts
// window.api の薄いラッパ。レンダラのコンポーネントは window.api を直接参照せず、
// この層を経由する（IPC 呼び出しをテスト/差し替え可能にするため）。
import type {
  AppInfo,
  ConflictPayload,
  CryptoChangePasswordArgs,
  CryptoDecryptToPlainArgs,
  CryptoEncryptMemoArgs,
  CryptoLockArgs,
  CryptoOpenArgs,
  CryptoOpenResult,
  CryptoSaveEncryptedArgs,
  EditorReportActiveArgs,
  ExternalChangePayload,
  IndexUpdatedPayload,
  LinkOpenExternalArgs,
  LinkResolveMemoArgs,
  LinkResolveMemoResult,
  MemoCreateArgs,
  MemoDeleteArgs,
  MemoDuplicateArgs,
  MemoMoveArgs,
  MemoReadArgs,
  MemoReadWithEncodingArgs,
  MemoRenameArgs,
  MemoSaveArgs,
  MetaRecoveredPayload,
  OpErrorPayload,
  SearchGlobalArgs,
  SearchHistoryAddArgs,
  TabCreateArgs,
  TabOpenTreeArgs,
  TabRegisterArgs,
  TabRemoveArgs,
  TabRenameArgs,
  TabReorderArgs,
  TrashFallbackPayload,
  TreeUpdateStructureArgs
} from '@shared/ipc-contract';
import type {
  AppSettings,
  AppSettingsPatch,
  MemoInfo,
  MemoReadResult,
  Result,
  SaveResult,
  SearchHit,
  TabInfo,
  TreeSnapshot
} from '@shared/models';

export const ipc = {
  getAppInfo: (): Promise<AppInfo> => window.api.app.getInfo(),

  listTabs: (): Promise<Result<TabInfo[]>> => window.api.tab.list(),
  registerTab: (args: TabRegisterArgs): Promise<Result<TabInfo>> => window.api.tab.register(args),
  createTab: (args: TabCreateArgs): Promise<Result<TabInfo>> => window.api.tab.create(args),
  openTree: (args: TabOpenTreeArgs): Promise<Result<TreeSnapshot>> => window.api.tab.openTree(args),
  renameTab: (args: TabRenameArgs): Promise<Result<void>> => window.api.tab.rename(args),
  removeTab: (args: TabRemoveArgs): Promise<Result<void>> => window.api.tab.remove(args),
  reorderTabs: (args: TabReorderArgs): Promise<Result<void>> => window.api.tab.reorder(args),

  readMemo: (args: MemoReadArgs): Promise<Result<MemoReadResult>> => window.api.memo.read(args),
  readMemoWithEncoding: (args: MemoReadWithEncodingArgs): Promise<Result<MemoReadResult>> =>
    window.api.memo.readWithEncoding(args),
  saveMemo: (args: MemoSaveArgs): Promise<Result<SaveResult>> => window.api.memo.save(args),
  createMemo: (args: MemoCreateArgs): Promise<Result<MemoInfo>> => window.api.memo.create(args),
  renameMemo: (args: MemoRenameArgs): Promise<Result<void>> => window.api.memo.rename(args),
  deleteMemo: (args: MemoDeleteArgs): Promise<Result<void>> => window.api.memo.delete(args),
  duplicateMemo: (args: MemoDuplicateArgs): Promise<Result<MemoInfo>> => window.api.memo.duplicate(args),
  moveMemo: (args: MemoMoveArgs): Promise<Result<void>> => window.api.memo.move(args),

  updateTreeStructure: (args: TreeUpdateStructureArgs): Promise<Result<void>> => window.api.tree.updateStructure(args),

  searchGlobal: (args: SearchGlobalArgs): Promise<Result<SearchHit[]>> => window.api.search.global(args),
  getSearchHistory: (): Promise<Result<string[]>> => window.api.search.historyGet(),
  addSearchHistory: (args: SearchHistoryAddArgs): Promise<Result<void>> => window.api.search.historyAdd(args),

  getSettings: (): Promise<Result<AppSettings>> => window.api.settings.get(),
  setSettings: (patch: AppSettingsPatch): Promise<Result<AppSettings>> => window.api.settings.set(patch),

  reportActiveMemo: (active: EditorReportActiveArgs['active']): Promise<Result<void>> =>
    window.api.editor.reportActive({ active }),

  openExternalLink: (args: LinkOpenExternalArgs): Promise<Result<void>> => window.api.link.openExternal(args),
  resolveMemoLink: (args: LinkResolveMemoArgs): Promise<Result<LinkResolveMemoResult | null>> =>
    window.api.link.resolveMemo(args),

  encryptMemo: (args: CryptoEncryptMemoArgs): Promise<Result<MemoInfo>> => window.api.crypto.encryptMemo(args),
  decryptMemoToPlain: (args: CryptoDecryptToPlainArgs): Promise<Result<MemoInfo>> =>
    window.api.crypto.decryptMemoToPlain(args),
  openEncryptedMemo: (args: CryptoOpenArgs): Promise<Result<CryptoOpenResult>> => window.api.crypto.open(args),
  saveEncryptedMemo: (args: CryptoSaveEncryptedArgs): Promise<Result<SaveResult>> => window.api.crypto.saveEncrypted(args),
  changeMemoPassword: (args: CryptoChangePasswordArgs): Promise<Result<void>> => window.api.crypto.changePassword(args),
  lockMemo: (args: CryptoLockArgs): Promise<Result<void>> => window.api.crypto.lock(args),

  onMetaRecovered: (handler: (payload: MetaRecoveredPayload) => void): (() => void) =>
    window.api.events.onMetaRecovered(handler),
  onTrashFallback: (handler: (payload: TrashFallbackPayload) => void): (() => void) =>
    window.api.events.onTrashFallback(handler),
  onIndexUpdated: (handler: (payload: IndexUpdatedPayload) => void): (() => void) =>
    window.api.events.onIndexUpdated(handler),
  onExternalChange: (handler: (payload: ExternalChangePayload) => void): (() => void) =>
    window.api.events.onExternalChange(handler),
  onConflict: (handler: (payload: ConflictPayload) => void): (() => void) => window.api.events.onConflict(handler),
  onOpError: (handler: (payload: OpErrorPayload) => void): (() => void) => window.api.events.onOpError(handler)
};
