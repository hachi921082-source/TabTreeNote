import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ipc } from './ipc';
import { useTheme } from './theme/useTheme';
import { createOpenMemoState, resolveEffectiveEol, withUpdatedHash, type OpenMemoState } from './editor/eolKeeper';
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings, type EditorStats } from './editor/codeMirrorSetup';
import { AUTO_RENAME_DEBOUNCE_MS, buildAutoRenameCandidate, computeFirstNonEmptyLine } from './editor/autoRename';
import { CodeMirrorEditor, type RevealTarget } from './components/Editor/CodeMirrorEditor';
import type { DetectedLink } from './editor/links';
import { TabBar } from './components/TabBar/TabBar';
import { Tree } from './components/Tree/Tree';
import { NameInputDialog } from './components/dialogs/NameInputDialog';
import { ConfirmDialog } from './components/dialogs/ConfirmDialog';
import { ConflictDialog } from './components/dialogs/ConflictDialog';
import { PasswordDialog, type PasswordDialogMode, type PasswordDialogSubmitValues } from './components/dialogs/PasswordDialog';
import { SearchPanel } from './components/Search/SearchPanel';
import { StatusBar } from './components/StatusBar/StatusBar';
import { SettingsDialog } from './components/Settings/SettingsDialog';
import { EMPTY_SELECTION, type SelectionState } from './store/selection';
import {
  dropZoneToPosition,
  toMetaTree,
  updateTreeNode,
  type DropZone,
  type MemoDragPayload
} from './components/Tree/treeView';
import { collectTreeNames, insertTreeNode, isDescendantOf, orderForBatchInsert, removeTreeNode } from '@shared/treeOps';
import { DEFAULT_SHORTCUTS, matchesShortcut, type ShortcutAction } from '@shared/shortcuts';
import type {
  AddPosition,
  AppInfo,
  ConflictPayload,
  EditorReportActiveArgs,
  ExternalChangePayload,
  MetaRecoveredPayload,
  OpErrorPayload,
  TrashFallbackPayload
} from '@shared/ipc-contract';
import type { AppSettings, AppSettingsPatch, MetaTreeNode, SearchHit, TabInfo, TreeNode } from '@shared/models';

const MIN_TREE_WIDTH = 160;
const MAX_TREE_WIDTH = 600;
const DEFAULT_TREE_WIDTH = 260;

// Ctrl+ホイールでのフォントサイズ変更（DESIGN §2.3）の範囲・刻み幅。
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 32;
const FONT_SIZE_STEP = 1;
// フォントサイズの settings:set 永続化のデバウンス（ホイール操作中に毎回 IPC を叩かないため）。
const FONT_SIZE_PERSIST_DEBOUNCE_MS = 500;

function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

// リンク機能（M5, DESIGN §2.8）の既定値。settings:get 応答（AppSettings.links）で上書きされる。
const DEFAULT_LINK_SETTINGS: AppSettings['links'] = { openTrigger: 'ctrlClick', confirmBeforeOpen: true };

// 暗号化メモの低頻度自動保存デバウンス既定値（M6, DESIGN §2.6「編集停止から一定時間のデバウンス」）。
// settings:get 応答（AppSettings.autosave.encryptedDebounceMs）で上書きされる。
const DEFAULT_ENCRYPTED_AUTOSAVE_MS = 5000;
// 平文メモの自動保存デバウンス既定値（M7, DESIGN §2.6「適度な自動保存。変更がなければ書き込まない」）。
// 暗号化メモと同じ「編集停止からのデバウンス」方式を平文メモにも適用する（developer 判断。
// タブ/メモ切替時の即時自動保存トリガーまでは本 M7 では実装せず、既存の未保存確認ダイアログを
// 安全網として残す。詳細は requestCloseCurrentMemo 付近のコメント参照）。
// settings:get 応答（AppSettings.autosave.plainDebounceMs）で上書きされる。
const DEFAULT_PLAIN_AUTOSAVE_MS = 1500;

interface CryptoDialogRequest {
  mode: PasswordDialogMode;
  tabId: string;
  memoName: string;
}

interface NameDialogRequest {
  title: string;
  label: string;
  initialValue?: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
}

interface ConfirmDialogRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function App() {
  const { theme, setTheme } = useTheme('light');
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const [dragging, setDragging] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);

  const [openMemo, setOpenMemo] = useState<OpenMemoState | null>(null);
  const [contentLF, setContentLF] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editorSettings, setEditorSettings] = useState<EditorSettings>(DEFAULT_EDITOR_SETTINGS);
  const [editorStats, setEditorStats] = useState<EditorStats | null>(null);
  // リンク機能設定（M5, DESIGN §2.8）。settings:get 応答で上書きされる。
  const [linkSettings, setLinkSettings] = useState<AppSettings['links']>(DEFAULT_LINK_SETTINGS);
  // 設定画面（M7）が扱う残りの AppSettings フィールド。settings:get 応答で上書きされる。
  const [autosaveSettings, setAutosaveSettings] = useState<AppSettings['autosave']>({
    plainDebounceMs: DEFAULT_PLAIN_AUTOSAVE_MS,
    encryptedDebounceMs: DEFAULT_ENCRYPTED_AUTOSAVE_MS
  });
  const [eolPolicy, setEolPolicy] = useState<AppSettings['eol']['policy']>('preserve');
  // 保存系 useCallback（handleSave/performPlainAutosave 等）から常に最新の改行コードポリシーを
  // 読むための ref（dirtyRef 等と同じ理由, M7）。
  const eolPolicyRef = useRef(eolPolicy);
  useEffect(() => {
    eolPolicyRef.current = eolPolicy;
  }, [eolPolicy]);
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({ ...DEFAULT_SHORTCUTS });
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const fontSizePersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorWheelCleanup = useRef<(() => void) | null>(null);
  // reviewer 指摘 M2-R1-01: selectTab/openMemoByName の未保存確認ガードは deps に dirty を
  // 含めない useCallback から参照するため、state の dirty をそのまま読むと初回レンダー時点の
  // 値（false）を閉じ込めた stale closure になり、確認ダイアログが一度も発火しなかった。
  // ref 経由で常に最新値を読むことで、コールバックの再生成頻度（textarea 入力毎の identity
  // 変化）を避けつつ最新の dirty を参照できるようにする。
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  // handleJumpToHit（M3-②）が selectTab 完了後に「実際に切り替わったか（未保存確認キャンセルで
  // 中断されていないか）」を判定するために、dirtyRef と同じ理由で ref 経由の最新値参照が必要。
  const selectedTabIdRef = useRef(selectedTabId);
  useEffect(() => {
    selectedTabIdRef.current = selectedTabId;
  }, [selectedTabId]);
  // ファイル監視（M4）: evt:conflict/evt:externalChange のハンドラや editor:reportActive の
  // 送信箇所は useCallback の deps に含めない箇所から最新の openMemo を参照する必要があるため、
  // dirtyRef/selectedTabIdRef と同じ理由で ref 経由の参照を用意する。
  const openMemoRef = useRef(openMemo);
  useEffect(() => {
    openMemoRef.current = openMemo;
  }, [openMemo]);
  // 暗号化メモの低頻度自動保存（M6）が、非同期タイマー発火時点の最新本文を読むための ref
  // （dirtyRef/openMemoRef と同じ理由）。
  const contentLFRef = useRef(contentLF);
  useEffect(() => {
    contentLFRef.current = contentLF;
  }, [contentLF]);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogRequest | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogRequest | null>(null);
  const [trashFallback, setTrashFallback] = useState<TrashFallbackPayload | null>(null);
  // 外部変更との競合（M4, DESIGN §3.3）。表示中はエディタ入力・保存をロックする。
  const [conflictInfo, setConflictInfo] = useState<{ tabId: string; memoName: string } | null>(null);
  const conflictInfoRef = useRef(conflictInfo);
  useEffect(() => {
    conflictInfoRef.current = conflictInfo;
  }, [conflictInfo]);
  // パスワード入力ダイアログ（設定/解除/開封/変更, M6）。
  const [cryptoDialog, setCryptoDialog] = useState<CryptoDialogRequest | null>(null);
  const [cryptoDialogError, setCryptoDialogError] = useState<string | null>(null);
  // 暗号化メモの低頻度自動保存デバウンス（既定値。settings:get 応答で上書き, DESIGN §2.6）。
  const encryptedAutosaveMsRef = useRef(DEFAULT_ENCRYPTED_AUTOSAVE_MS);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 平文メモの自動保存デバウンス（M7。既定値。settings:get 応答で上書き, DESIGN §2.6）。
  const plainAutosaveMsRef = useRef(DEFAULT_PLAIN_AUTOSAVE_MS);
  const plainAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // AutoReName（M7, PLAN §5.9/Fix12）: 直近に判定した「最初の非空行」の値（変化検出の基準）と
  // デバウンスタイマー。暗号化メモでは使わない（値は無視される）。
  const autoRenameBaselineRef = useRef<string | null>(null);
  const autoRenameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 同一メモのまま本文を強制的に再読込させるための世代カウンタ（M4）。CodeMirrorEditor は
  // 非制御コンポーネントで `initialContentLF` はマウント時のみ使用するため、外部変更の
  // 静かな反映・競合解決で本文を書き換える際は key に含めてこの値を進め、明示的に
  // 再マウントさせる（同時に Undo 履歴もリセットされるのが適切、内容が外部由来のため）。
  const [reloadGeneration, setReloadGeneration] = useState(0);

  // --- 全文検索（M3-②, docs/milestones/M3-search.md） ---
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [revealTarget, setRevealTarget] = useState<RevealTarget | null>(null);
  const revealTokenRef = useRef(0);

  // 初期化: app:getInfo / settings:get（テーマ復元）/ tab:list。
  useEffect(() => {
    ipc
      .getAppInfo()
      .then(setAppInfo)
      .catch((e: unknown) => console.error('app:getInfo failed', e));

    ipc
      .getSettings()
      .then((res) => {
        if (res.ok) {
          setTheme(res.value.theme);
          setTreeWidth(res.value.window.treeWidth);
          setEditorSettings((prev) => ({ ...prev, ...res.value.editorDefaults }));
          setLinkSettings(res.value.links);
          encryptedAutosaveMsRef.current = res.value.autosave.encryptedDebounceMs;
          plainAutosaveMsRef.current = res.value.autosave.plainDebounceMs;
          setAutosaveSettings(res.value.autosave);
          setEolPolicy(res.value.eol.policy);
          setShortcuts(res.value.shortcuts);
        }
      })
      .catch((e: unknown) => console.error('settings:get failed', e));

    void refreshTabs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // evt:metaRecovered / evt:trashFallback / evt:opError 購読。
  useEffect(() => {
    const unsubscribeRecovered = ipc.onMetaRecovered((payload: MetaRecoveredPayload) => {
      setStatusMessage(`メタ復旧通知: ${payload.message}`);
    });
    const unsubscribeTrashFallback = ipc.onTrashFallback((payload: TrashFallbackPayload) => {
      setTrashFallback(payload);
    });
    // M4 で初実装（ファイル監視のバックグラウンド I/O 失敗等, 00-core-principles.md §8）。
    const unsubscribeOpError = ipc.onOpError((payload: OpErrorPayload) => {
      setStatusMessage(`エラー[${payload.code}]: ${payload.message}`);
    });
    return () => {
      unsubscribeRecovered();
      unsubscribeTrashFallback();
      unsubscribeOpError();
    };
  }, []);

  const refreshTabs = useCallback(async () => {
    const res = await ipc.listTabs();
    if (res.ok) {
      setTabs(res.value);
    } else {
      setStatusMessage(`タブ一覧取得エラー: ${res.error.message}`);
    }
  }, []);

  const refreshTree = useCallback(async (tabId: string) => {
    const res = await ipc.openTree({ tabId });
    if (res.ok) {
      setTree([...res.value.tree]);
    } else {
      setStatusMessage(`ツリー取得エラー: ${res.error.message}`);
    }
  }, []);

  // 現在開いている(かつ未保存の変更があるか)状態をメインへ通知する（M4、evt:conflict/
  // evt:externalChange の振り分けに使われる。src/main/watch/activeMemoState.ts 参照）。
  const reportActiveMemo = useCallback((active: EditorReportActiveArgs['active']): void => {
    void ipc.reportActiveMemo(active).catch((e: unknown) => console.error('editor:reportActive failed', e));
  }, []);

  // --- 暗号化メモ（M6, DESIGN §2.9）: ロック前/切替前の自動保存+セッション鍵破棄、低頻度自動保存 ---

  const clearEncryptedAutosaveTimer = useCallback((): void => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  // --- 平文メモの自動保存（M7, DESIGN §2.6「適度な自動保存」） / AutoReName（M7, PLAN §5.9/Fix12） ---

  const clearPlainAutosaveTimer = useCallback((): void => {
    if (plainAutosaveTimerRef.current) {
      clearTimeout(plainAutosaveTimerRef.current);
      plainAutosaveTimerRef.current = null;
    }
  }, []);

  const clearAutoRenameTimer = useCallback((): void => {
    if (autoRenameTimerRef.current) {
      clearTimeout(autoRenameTimerRef.current);
      autoRenameTimerRef.current = null;
    }
  }, []);

  /**
   * 現在開いているメモを安全に閉じてよいかを判定し、必要な後始末を行う。
   * - 平文メモ: dirty なら window.confirm で破棄確認する（既存 M2 の挙動を維持）。
   * - 暗号化メモ: 無確認で破棄しない（DESIGN §2.9）。dirty なら crypto:saveEncrypted で
   *   自動保存してから crypto:lock でセッション鍵を破棄する（既定は自動保存を優先,
   *   PLAN §5.5 ロック手順1-2）。保存が失敗した場合（競合等）は中断し、呼び出し元は
   *   メモ切り替えを行わない。
   * refs 経由で最新値を読むため、deps を空にできる（selectTab 等と同じ理由, M2-R1-01）。
   */
  const requestCloseCurrentMemo = useCallback(async (): Promise<boolean> => {
    const om = openMemoRef.current;
    if (!om) return true;

    if (!om.encrypted) {
      if (dirtyRef.current && !window.confirm('未保存の変更があります。破棄して別のメモを開きますか？')) {
        return false;
      }
      // 切り替えが確定した時点で AutoReName/平文自動保存の保留タイマーを解除する（M7。
      // キャンセルされた場合はここへ到達しないため、保留中の自動保存/リネームは温存される）。
      clearAutoRenameTimer();
      clearPlainAutosaveTimer();
      return true;
    }

    clearEncryptedAutosaveTimer();
    if (dirtyRef.current) {
      const res = await ipc.saveEncryptedMemo({
        tabId: om.tabId,
        memoName: om.memoName,
        contentLF: contentLFRef.current,
        eol: resolveEffectiveEol(om.eol, eolPolicyRef.current),
        expectedHash: om.lastKnownHash
      });
      if (!res.ok) {
        setStatusMessage(`暗号化メモの自動保存に失敗しました[${res.error.code}]: ${res.error.message}`);
        return false;
      }
    }
    const lockRes = await ipc.lockMemo({ tabId: om.tabId, memoName: om.memoName });
    if (!lockRes.ok) {
      // ロック解除（セッション鍵破棄）自体の失敗は致命的ではない（次回開封時にパスワード
      // 入力すれば足りる）ため、内部ログのみでメモ切り替え自体はブロックしない。
      console.error('crypto:lock failed', lockRes.error);
    }
    return true;
  }, [clearEncryptedAutosaveTimer, clearAutoRenameTimer, clearPlainAutosaveTimer]);

  const performEncryptedAutosave = useCallback(async (): Promise<void> => {
    const om = openMemoRef.current;
    if (!om || !om.encrypted || !dirtyRef.current) return;
    const conflict = conflictInfoRef.current;
    if (conflict && conflict.tabId === om.tabId && conflict.memoName === om.memoName) return; // 解決中ロック。

    const res = await ipc.saveEncryptedMemo({
      tabId: om.tabId,
      memoName: om.memoName,
      contentLF: contentLFRef.current,
      eol: resolveEffectiveEol(om.eol, eolPolicyRef.current),
      expectedHash: om.lastKnownHash
    });
    if (res.ok) {
      setOpenMemo((prev) =>
        prev && prev.tabId === om.tabId && prev.memoName === om.memoName ? withUpdatedHash(prev, res.value.savedHash) : prev
      );
      setDirty(false);
      reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: false });
      setStatusMessage(`自動保存しました（${om.memoName}）`);
    } else if (res.error.code !== 'CONFLICT') {
      // CONFLICT は evt:conflict 経由の競合ダイアログに解決を委ねる（ここでは静かに諦める）。
      setStatusMessage(`自動保存エラー[${res.error.code}]: ${res.error.message}`);
    }
  }, [reportActiveMemo]);

  const scheduleEncryptedAutosave = useCallback((): void => {
    clearEncryptedAutosaveTimer();
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void performEncryptedAutosave();
    }, encryptedAutosaveMsRef.current);
  }, [clearEncryptedAutosaveTimer, performEncryptedAutosave]);

  // 平文メモの自動保存（M7, DESIGN §2.6「適度な自動保存。変更がなければ書き込まない」）。
  // 暗号化メモの低頻度自動保存と対称の「編集停止からのデバウンス」方式（AppSettings.autosave.
  // plainDebounceMs、既定値より短い）。
  const performPlainAutosave = useCallback(async (): Promise<void> => {
    const om = openMemoRef.current;
    if (!om || om.encrypted || !dirtyRef.current) return;
    const conflict = conflictInfoRef.current;
    if (conflict && conflict.tabId === om.tabId && conflict.memoName === om.memoName) return; // 解決中ロック。

    const res = await ipc.saveMemo({
      tabId: om.tabId,
      memoName: om.memoName,
      contentLF: contentLFRef.current,
      eol: resolveEffectiveEol(om.eol, eolPolicyRef.current),
      encoding: om.encoding,
      expectedHash: om.lastKnownHash
    });
    if (res.ok) {
      setOpenMemo((prev) =>
        prev && prev.tabId === om.tabId && prev.memoName === om.memoName ? withUpdatedHash(prev, res.value.savedHash) : prev
      );
      setDirty(false);
      reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: false });
      setStatusMessage(`自動保存しました（${om.memoName}）`);
    } else if (res.error.code !== 'CONFLICT') {
      // CONFLICT は evt:conflict 経由の競合ダイアログに解決を委ねる（ここでは静かに諦める）。
      setStatusMessage(`自動保存エラー[${res.error.code}]: ${res.error.message}`);
    }
  }, [reportActiveMemo]);

  const schedulePlainAutosave = useCallback((): void => {
    clearPlainAutosaveTimer();
    plainAutosaveTimerRef.current = setTimeout(() => {
      plainAutosaveTimerRef.current = null;
      void performPlainAutosave();
    }, plainAutosaveMsRef.current);
  }, [clearPlainAutosaveTimer, performPlainAutosave]);

  // AutoReName（M7, PLAN §5.9/Fix12, DESIGN §2.2）: 最初の非空行が実際に変化した場合のみ、
  // 編集停止から AUTO_RENAME_DEBOUNCE_MS 後にサニタイズ+重複回避を経てリネームする。
  // 暗号化メモは対象外（呼び出し側の handleEditorChange で除外する）。
  const performAutoRename = useCallback(
    async (tabId: string, oldName: string): Promise<void> => {
      const om = openMemoRef.current;
      if (!om || om.tabId !== tabId || om.memoName !== oldName || om.encrypted) return;
      const conflict = conflictInfoRef.current;
      if (conflict && conflict.tabId === tabId && conflict.memoName === oldName) return; // 解決中ロック。

      const rawFirstLine = computeFirstNonEmptyLine(contentLFRef.current);
      if (!rawFirstLine) return;
      const candidate = buildAutoRenameCandidate(rawFirstLine, collectTreeNames(toMetaTree(tree)), oldName);
      if (!candidate) return;

      const res = await ipc.renameMemo({ tabId, oldName, newName: candidate });
      if (!res.ok) {
        // ベストエフォートの自動処理のため、ユーザーへは通知せず内部ログのみに留める
        // （00-core-principles.md §10 と同様、レンダラ向けには詳細を出さない方針に倣う）。
        console.error('AutoReName failed', res.error);
        return;
      }
      setOpenMemo((prev) => (prev && prev.tabId === tabId && prev.memoName === oldName ? { ...prev, memoName: candidate } : prev));
      reportActiveMemo({ tabId, memoName: candidate, dirty: dirtyRef.current });
      await refreshTree(tabId);
    },
    [tree, reportActiveMemo, refreshTree]
  );

  const scheduleAutoRename = useCallback(
    (tabId: string, oldName: string): void => {
      clearAutoRenameTimer();
      autoRenameTimerRef.current = setTimeout(() => {
        autoRenameTimerRef.current = null;
        void performAutoRename(tabId, oldName);
      }, AUTO_RENAME_DEBOUNCE_MS);
    },
    [clearAutoRenameTimer, performAutoRename]
  );

  useEffect(() => clearEncryptedAutosaveTimer, [clearEncryptedAutosaveTimer]);
  useEffect(() => clearPlainAutosaveTimer, [clearPlainAutosaveTimer]);
  useEffect(() => clearAutoRenameTimer, [clearAutoRenameTimer]);

  // evt:conflict / evt:externalChange 購読（M4, DESIGN §3.3 / docs/milestones/M4-watch.md）。
  // 経路の分離厳守: 本 effect はツリー再取得・「編集中でない」開いているメモの静かな反映
  // （または競合ダイアログ表示）のみを行う。全文検索インデックスの反映はメイン側
  // （watch/watcher.ts 経路②）で完結済み（evt:indexUpdated で SearchPanel が追従する）。
  useEffect(() => {
    const unsubscribeConflict = ipc.onConflict((payload: ConflictPayload) => {
      const om = openMemoRef.current;
      // 現在開いているメモに対する通知のみ扱う（main 側は dirty な active メモのみに絞って
      // 発火するが、念のため一致確認する）。
      if (om && om.tabId === payload.tabId && om.memoName === payload.memoName) {
        setConflictInfo({ tabId: payload.tabId, memoName: payload.memoName });
      }
    });

    const unsubscribeExternalChange = ipc.onExternalChange((payload: ExternalChangePayload) => {
      if (payload.tabId === selectedTabIdRef.current) {
        void refreshTree(payload.tabId);
      }

      const om = openMemoRef.current;
      if (!om || om.tabId !== payload.tabId) return;
      const entry = payload.changes.find((c) => c.memoName === om.memoName);
      if (!entry) return;
      // main 側は dirty なら evt:conflict に振り分ける想定だが、通知間の僅かな競合に備えて
      // ここでも dirty ならクロバーしない（防御的ガード）。
      if (dirtyRef.current) return;

      if (entry.kind === 'unlink') {
        setOpenMemo(null);
        setContentLF('');
        setDirty(false);
        setEditorStats(null);
        setConflictInfo(null);
        reportActiveMemo(null);
        setStatusMessage(`「${om.memoName}」は外部で削除されました。`);
        return;
      }

      void (async () => {
        if (om.encrypted) {
          // 暗号化メモは memo:read で本文を取得できない（contentLF:'' が返る仕様）ため、
          // handleConflictAdoptExternal と同様にセッション鍵を破棄して閉じ、再度パスワード
          // 入力での開き直しを促す（空文字での静かな上書きによるデータ消失を防ぐ, レビュー指摘対応）。
          await ipc.lockMemo({ tabId: om.tabId, memoName: om.memoName });
          clearEncryptedAutosaveTimer();
          setOpenMemo(null);
          setContentLF('');
          setDirty(false);
          setEditorStats(null);
          reportActiveMemo(null);
          setStatusMessage(`「${om.memoName}」は外部で変更されました。開き直してください。`);
          return;
        }
        const res = await ipc.readMemo({ tabId: om.tabId, memoName: om.memoName });
        if (!res.ok) return;
        setOpenMemo(createOpenMemoState(om.tabId, om.memoName, res.value));
        setContentLF(res.value.contentLF);
        setDirty(false);
        setEditorStats(null);
        setReloadGeneration((g) => g + 1);
        // 外部内容の静かな反映（M7）: 保留中の自動保存/AutoReName の判定基準を新しい本文へ引き直す。
        clearPlainAutosaveTimer();
        clearAutoRenameTimer();
        autoRenameBaselineRef.current = computeFirstNonEmptyLine(res.value.contentLF);
        reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: false });
        setStatusMessage(`「${om.memoName}」の外部変更を反映しました。`);
      })();
    });

    return () => {
      unsubscribeConflict();
      unsubscribeExternalChange();
    };
  }, [refreshTree, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer, clearAutoRenameTimer]);

  // 競合ダイアログの解決アクション（M4）。
  const handleConflictKeepMine = useCallback(() => {
    if (!conflictInfo || !openMemo) {
      setConflictInfo(null);
      return;
    }
    void (async () => {
      // expectedHash を渡さず（=競合チェックを迂回して）強制上書きする。ユーザーが競合
      // ダイアログで明示的に選んだ意図的な上書きであり、既存の memo:save 競合チェックの
      // バイパスは本ケースに限定される（DESIGN §3.3）。暗号化メモは crypto:saveEncrypted を使う
      // （M6。セッション鍵は開封時のまま維持されているため引き続き保存できる）。
      const res = openMemo.encrypted
        ? await ipc.saveEncryptedMemo({
            tabId: openMemo.tabId,
            memoName: openMemo.memoName,
            contentLF,
            eol: resolveEffectiveEol(openMemo.eol, eolPolicyRef.current),
            expectedHash: undefined
          })
        : await ipc.saveMemo({
            tabId: openMemo.tabId,
            memoName: openMemo.memoName,
            contentLF,
            eol: resolveEffectiveEol(openMemo.eol, eolPolicyRef.current),
            encoding: openMemo.encoding,
            expectedHash: undefined
          });
      if (res.ok) {
        setOpenMemo(withUpdatedHash(openMemo, res.value.savedHash));
        setDirty(false);
        reportActiveMemo({ tabId: openMemo.tabId, memoName: openMemo.memoName, dirty: false });
        setStatusMessage(`保存しました（${openMemo.memoName}）`);
      } else {
        setStatusMessage(`保存エラー[${res.error.code}]: ${res.error.message}`);
      }
      setConflictInfo(null);
    })();
  }, [conflictInfo, openMemo, contentLF, reportActiveMemo]);

  const handleConflictAdoptExternal = useCallback(() => {
    if (!conflictInfo) return;
    const { tabId, memoName } = conflictInfo;
    void (async () => {
      if (openMemo?.encrypted) {
        // 暗号化メモは memo:read で本文を取得できない（M1 スコープの仕様通り本文非対応）ため、
        // 外部変更を採用する場合はセッション鍵を破棄して一旦閉じ、ユーザーに再度パスワード入力
        // での開き直しを求める（古い鍵のまま自動復号を試みて誤った結果を出さないための安全策,
        // developer 判断）。
        await ipc.lockMemo({ tabId, memoName });
        clearEncryptedAutosaveTimer();
        setOpenMemo(null);
        setContentLF('');
        setDirty(false);
        setEditorStats(null);
        reportActiveMemo(null);
        setStatusMessage(`「${memoName}」は外部で変更されました。開き直してください。`);
        setConflictInfo(null);
        return;
      }
      const res = await ipc.readMemo({ tabId, memoName });
      if (res.ok) {
        setOpenMemo(createOpenMemoState(tabId, memoName, res.value));
        setContentLF(res.value.contentLF);
        setDirty(false);
        setEditorStats(null);
        setReloadGeneration((g) => g + 1);
        // 外部内容の採用（M7）: 保留中の自動保存/AutoReName は古い本文を前提にしているため破棄し、
        // 判定基準を採用後の本文へ引き直す。
        clearPlainAutosaveTimer();
        clearAutoRenameTimer();
        autoRenameBaselineRef.current = computeFirstNonEmptyLine(res.value.contentLF);
        reportActiveMemo({ tabId, memoName, dirty: false });
        setStatusMessage(`「${memoName}」の外部変更を反映しました。`);
      } else {
        // 外部で削除されていた場合など。メモを閉じる。
        clearPlainAutosaveTimer();
        clearAutoRenameTimer();
        setOpenMemo(null);
        setContentLF('');
        setDirty(false);
        setEditorStats(null);
        reportActiveMemo(null);
        setStatusMessage(`「${memoName}」は外部で削除されました。`);
      }
      setConflictInfo(null);
    })();
  }, [conflictInfo, openMemo, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer, clearAutoRenameTimer]);

  const handleToggleTheme = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    void ipc.setSettings({ theme: next }).catch((e: unknown) => console.error('settings:set failed', e));
  }, [theme, setTheme]);

  // --- 設定画面（M7, docs/milestones/M7-polish.md）---
  // SettingsDialog 自体は IPC を呼ばず、すべて以下の onChange* 経由で App.tsx が settings:set を
  // 呼ぶ（Tree/TabBar 等、他コンポーネントと同じくファイル操作/設定保存は親経由という既存の
  // アーキテクチャ方針に合わせる, PLAN §1.3）。

  const applySettingsPatch = useCallback(async (patch: AppSettingsPatch): Promise<void> => {
    const res = await ipc.setSettings(patch);
    if (!res.ok) {
      setStatusMessage(`設定保存エラー[${res.error.code}]: ${res.error.message}`);
    }
  }, []);

  const handleChangeEditorSettingsFromDialog = useCallback(
    (patch: Partial<EditorSettings>) => {
      setEditorSettings((prev) => ({ ...prev, ...patch }));
      const persistable: Partial<AppSettings['editorDefaults']> = {};
      if (patch.wrap !== undefined) persistable.wrap = patch.wrap;
      if (patch.tabWidth !== undefined) persistable.tabWidth = patch.tabWidth;
      if (patch.softTab !== undefined) persistable.softTab = patch.softTab;
      if (patch.showLineNumbers !== undefined) persistable.showLineNumbers = patch.showLineNumbers;
      if (patch.fontSize !== undefined) persistable.fontSize = patch.fontSize;
      // showWhitespace/highlightActiveLine は AppSettings.editorDefaults に永続フィールドが無い
      // （data-model.md 未変更の範囲, codeMirrorSetup.ts EditorSettings 冒頭コメント参照）ため、
      // セッション内のみの設定として扱い settings:set には含めない（developer 判断）。
      if (Object.keys(persistable).length > 0) void applySettingsPatch({ editorDefaults: persistable });
    },
    [applySettingsPatch]
  );

  const handleChangeLinksFromDialog = useCallback(
    (patch: Partial<AppSettings['links']>) => {
      setLinkSettings((prev) => ({ ...prev, ...patch }));
      void applySettingsPatch({ links: patch });
    },
    [applySettingsPatch]
  );

  const handleChangeAutosaveFromDialog = useCallback(
    (patch: Partial<AppSettings['autosave']>) => {
      setAutosaveSettings((prev) => ({ ...prev, ...patch }));
      if (patch.plainDebounceMs !== undefined) plainAutosaveMsRef.current = patch.plainDebounceMs;
      if (patch.encryptedDebounceMs !== undefined) encryptedAutosaveMsRef.current = patch.encryptedDebounceMs;
      void applySettingsPatch({ autosave: patch });
    },
    [applySettingsPatch]
  );

  const handleChangeEolPolicyFromDialog = useCallback(
    (policy: AppSettings['eol']['policy']) => {
      setEolPolicy(policy);
      void applySettingsPatch({ eol: { policy } });
    },
    [applySettingsPatch]
  );

  const handleChangeShortcutFromDialog = useCallback(
    (action: ShortcutAction, value: string) => {
      setShortcuts((prev) => ({ ...prev, [action]: value }));
      void applySettingsPatch({ shortcuts: { [action]: value } });
    },
    [applySettingsPatch]
  );

  const selectTab = useCallback(async (tabId: string) => {
    // requestCloseCurrentMemo が平文/暗号化それぞれの適切なガード・後始末（平文=破棄確認,
    // 暗号化=自動保存+セッション鍵破棄, M6）を行う（refs 経由で最新値を読むため deps 不要）。
    if (!(await requestCloseCurrentMemo())) {
      return;
    }
    setSelectedTabId(tabId);
    setSelection(EMPTY_SELECTION);
    setOpenMemo(null);
    setContentLF('');
    setDirty(false);
    setEditorStats(null);
    setRevealTarget(null);
    setConflictInfo(null);
    reportActiveMemo(null);
    await refreshTree(tabId);
  }, [refreshTree, reportActiveMemo, requestCloseCurrentMemo]);

  const openMemoByName = useCallback(
    async (memoName: string, encrypted: boolean) => {
      if (!selectedTabId) return;
      if (!(await requestCloseCurrentMemo())) {
        return;
      }
      if (encrypted) {
        // 暗号化メモは開封にパスワードが必要（M6, crypto:open）。
        setCryptoDialog({ mode: 'unlockToOpen', tabId: selectedTabId, memoName });
        setCryptoDialogError(null);
        return;
      }
      const res = await ipc.readMemo({ tabId: selectedTabId, memoName });
      if (res.ok) {
        setOpenMemo(createOpenMemoState(selectedTabId, memoName, res.value));
        setContentLF(res.value.contentLF);
        setDirty(false);
        setEditorStats(null);
        setStatusMessage(null);
        // 通常のメモオープンでは前回のジャンプ位置を持ち越さない（handleJumpToHit は本関数の
        // 呼び出し後に必要な場合のみ revealTarget を再設定する）。
        setRevealTarget(null);
        setConflictInfo(null);
        setReloadGeneration(0);
        // AutoReName（M7）: 新規に開いたメモの「最初の非空行」を判定基準として記録する
        // （この直後に本文を変更していない限り発火しない）。
        autoRenameBaselineRef.current = computeFirstNonEmptyLine(res.value.contentLF);
        reportActiveMemo({ tabId: selectedTabId, memoName, dirty: false });
      } else {
        setStatusMessage(`メモ読込エラー: ${res.error.message}`);
      }
    },
    [selectedTabId, reportActiveMemo, requestCloseCurrentMemo]
  );

  // 全文検索の結果一覧からのジャンプ（M3-②）。ヒットしたタブ/メモへ切り替えてから、
  // 本文一致の場合は該当箇所を選択・スクロールする（revealTarget 経由、CodeMirrorEditor.tsx）。
  // `openMemoByName` は内部で「現在の」`selectedTabId`（state のクロージャ）を読むため、直前に
  // `selectTab` でタブを切り替えた場合、本関数の呼び出し時点で束縛された古い `openMemoByName`
  // クロージャを再利用すると切替前のタブを参照してしまう（stale closure）。そのため本関数では
  // `openMemoByName` に委譲せず、`hit.tabId`/`hit.memoName` を直接引数として `memo:read` する。
  const handleJumpToHit = useCallback(
    async (hit: SearchHit) => {
      if (selectedTabIdRef.current !== hit.tabId) {
        await selectTab(hit.tabId);
        if (selectedTabIdRef.current !== hit.tabId) {
          // 未保存確認をユーザーがキャンセルした等でタブ切替が行われなかった。ジャンプ中断。
          return;
        }
      } else if (!(await requestCloseCurrentMemo())) {
        // 同一タブ内で別メモへジャンプする場合は openMemoByName と同様のガード（M6）。
        return;
      }

      if (hit.encrypted) {
        // 暗号化メモは本文がインデックス対象外のため常に matchField==='name'（本文ジャンプ不可）。
        // パスワード入力での開封は求められるので unlockToOpen ダイアログへ委ねる。
        setCryptoDialog({ mode: 'unlockToOpen', tabId: hit.tabId, memoName: hit.memoName });
        setCryptoDialogError(null);
        return;
      }

      const res = await ipc.readMemo({ tabId: hit.tabId, memoName: hit.memoName });
      if (!res.ok) {
        setStatusMessage(`メモ読込エラー: ${res.error.message}`);
        return;
      }
      setOpenMemo(createOpenMemoState(hit.tabId, hit.memoName, res.value));
      setContentLF(res.value.contentLF);
      setDirty(false);
      setEditorStats(null);
      setStatusMessage(null);
      setRevealTarget(null);
      setConflictInfo(null);
      setReloadGeneration(0);
      autoRenameBaselineRef.current = computeFirstNonEmptyLine(res.value.contentLF); // AutoReName（M7）。
      reportActiveMemo({ tabId: hit.tabId, memoName: hit.memoName, dirty: false });
      if (hit.matchField === 'body' && hit.matchStart !== undefined && hit.matchEnd !== undefined) {
        revealTokenRef.current += 1;
        setRevealTarget({ from: hit.matchStart, to: hit.matchEnd, token: revealTokenRef.current });
      }
    },
    [selectTab, reportActiveMemo, requestCloseCurrentMemo]
  );

  // --- リンク機能（M5, DESIGN §2.8）: memo: 遷移 / URL・mailto・ファイルパスの外部起動 ---

  // `memo:` リンクの解決先を開く（暗号化メモはパスワード入力ダイアログへ委ねる, M6。
  // handleJumpToHit と似た「タブ切替→本文読込」処理だが、`hit.encrypted` のような事前情報が
  // 無い（link:resolveMemo はメモ名/tabIdのみ返す, PLAN §2.5）ため、暗号化判定は
  // memo:read の結果から行う独立実装にしている）。
  const openMemoDirect = useCallback(
    async (tabId: string, memoName: string) => {
      const res = await ipc.readMemo({ tabId, memoName });
      if (!res.ok) {
        setStatusMessage(`メモ読込エラー: ${res.error.message}`);
        return;
      }
      if (res.value.encrypted) {
        setCryptoDialog({ mode: 'unlockToOpen', tabId, memoName });
        setCryptoDialogError(null);
        return;
      }
      setOpenMemo(createOpenMemoState(tabId, memoName, res.value));
      setContentLF(res.value.contentLF);
      setDirty(false);
      setEditorStats(null);
      setStatusMessage(null);
      setRevealTarget(null);
      setConflictInfo(null);
      setReloadGeneration(0);
      autoRenameBaselineRef.current = computeFirstNonEmptyLine(res.value.contentLF); // AutoReName（M7）。
      reportActiveMemo({ tabId, memoName, dirty: false });
    },
    [reportActiveMemo]
  );

  // 本文中のリンク（CodeMirrorEditor.tsx の buildLinkExtension 経由）をクリックした際のハンドラ。
  const handleLinkClick = useCallback(
    (link: DetectedLink) => {
      if (link.kind === 'memo') {
        if (!selectedTabId) return;
        const memoRef = link.raw.slice('memo:'.length);
        void (async () => {
          const res = await ipc.resolveMemoLink({ currentTabId: selectedTabId, memoRef });
          // 解決不能はエラーダイアログを出さず何もしない（DESIGN §2.8）。
          if (!res.ok || !res.value) return;
          const { tabId, memoName } = res.value;
          if (tabId !== selectedTabId) {
            await selectTab(tabId); // 未保存確認/暗号化メモの後始末は selectTab 内部で行う（M6）。
            if (selectedTabIdRef.current !== tabId) return; // ユーザーがキャンセルし切替されなかった。
          } else if (memoName && !(await requestCloseCurrentMemo())) {
            return;
          }
          if (memoName) await openMemoDirect(tabId, memoName);
        })();
        return;
      }

      // url / mailto / path: 外部起動（設定で確認ダイアログを挟む, 既定 ON）。
      // `kind`/`raw` を分割代入で束縛し直す（narrowing 済みの `link.kind` を後続の nested
      // closure からもそのまま参照できるようにするため。TS は nested closure 内で
      // パラメータの型ガードによる narrowing を保持しないことがあるための回避）。
      const { kind, raw } = link;
      const performOpen = (): void => {
        void (async () => {
          const res = await ipc.openExternalLink({
            kind,
            raw,
            baseTabId: selectedTabId ?? undefined
          });
          if (!res.ok) setStatusMessage(`外部起動エラー[${res.error.code}]: ${res.error.message}`);
        })();
      };

      if (linkSettings.confirmBeforeOpen) {
        const kindLabel = kind === 'url' ? 'URL' : kind === 'mailto' ? 'メールアドレス' : 'パス';
        setConfirmDialog({
          title: '外部を開く確認',
          message: `次の${kindLabel}を外部アプリで開きます。よろしいですか？\n${raw}`,
          confirmLabel: '開く',
          onConfirm: () => {
            setConfirmDialog(null);
            performOpen();
          }
        });
      } else {
        performOpen();
      }
    },
    [selectedTabId, linkSettings, selectTab, openMemoDirect, requestCloseCurrentMemo]
  );

  // CodeMirrorEditor（非制御）からの通知。doc 変更のたびに contentLF を最新化する。
  const handleEditorChange = useCallback(
    (content: string) => {
      setContentLF(content);
      setDirty(true);
      const om = openMemoRef.current;
      if (om) {
        reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: true });
        if (om.encrypted) {
          // 暗号化メモの低頻度自動保存（DESIGN §2.6「編集停止から一定時間のデバウンス」, M6）。
          // AutoReName は暗号化メモ対象外（DESIGN §2.2/§2.9, M6/M7）。
          scheduleEncryptedAutosave();
        } else {
          // 平文メモの自動保存（M7, DESIGN §2.6「適度な自動保存」）。
          schedulePlainAutosave();
          // AutoReName（M7, PLAN §5.9/Fix12）: 最初の非空行が実際に変化した場合のみ発火する。
          const firstLine = computeFirstNonEmptyLine(content);
          if (firstLine.length > 0 && firstLine !== autoRenameBaselineRef.current) {
            autoRenameBaselineRef.current = firstLine;
            scheduleAutoRename(om.tabId, om.memoName);
          }
        }
      }
    },
    [reportActiveMemo, scheduleEncryptedAutosave, schedulePlainAutosave, scheduleAutoRename]
  );

  const handleEditorStats = useCallback((stats: EditorStats) => {
    setEditorStats(stats);
  }, []);

  const handleSave = useCallback(async () => {
    // conflictInfo 表示中（対象メモが競合解決待ち）はロックする。解決は
    // handleConflictKeepMine/handleConflictAdoptExternal 経由でのみ行う（DESIGN §3.3 解決中ロック）。
    if (!openMemo || !dirty || (conflictInfo && conflictInfo.tabId === openMemo.tabId && conflictInfo.memoName === openMemo.memoName)) {
      return;
    }
    // 手動保存は保留中の自動保存タイマーを無効化する（二重保存を避ける, M6/M7）。
    clearEncryptedAutosaveTimer();
    clearPlainAutosaveTimer();
    const res = openMemo.encrypted
      ? await ipc.saveEncryptedMemo({
          tabId: openMemo.tabId,
          memoName: openMemo.memoName,
          contentLF,
          eol: resolveEffectiveEol(openMemo.eol, eolPolicyRef.current),
          expectedHash: openMemo.lastKnownHash
        })
      : await ipc.saveMemo({
          tabId: openMemo.tabId,
          memoName: openMemo.memoName,
          contentLF,
          eol: resolveEffectiveEol(openMemo.eol, eolPolicyRef.current),
          encoding: openMemo.encoding,
          expectedHash: openMemo.lastKnownHash
        });
    if (res.ok) {
      setOpenMemo(withUpdatedHash(openMemo, res.value.savedHash));
      setDirty(false);
      reportActiveMemo({ tabId: openMemo.tabId, memoName: openMemo.memoName, dirty: false });
      setStatusMessage(`保存しました（${openMemo.memoName}）`);
    } else {
      setStatusMessage(`保存エラー[${res.error.code}]: ${res.error.message}`);
    }
  }, [openMemo, contentLF, dirty, conflictInfo, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]);

  // 「ロック」ボタン（暗号化メモを開封中のみ表示）: dirty なら自動保存してからセッション鍵を破棄し、
  // レンダラ側の CodeMirror ドキュメント/Undo 履歴も破棄する（厳格な履歴破棄, DESIGN §2.9）。
  const handleLockMemo = useCallback(async () => {
    if (!openMemo || !openMemo.encrypted) return;
    const memoName = openMemo.memoName;
    if (!(await requestCloseCurrentMemo())) return;
    setOpenMemo(null);
    setContentLF('');
    setDirty(false);
    setEditorStats(null);
    setConflictInfo(null);
    reportActiveMemo(null);
    setStatusMessage(`「${memoName}」をロックしました。`);
  }, [openMemo, requestCloseCurrentMemo, reportActiveMemo]);

  // --- パスワード設定/解除/変更ダイアログ（M6, DESIGN §2.9） ---
  // 対象メモが「現在開封中かつ未保存」の場合は、保存前の平文が失われる/保存後ハッシュとの
  // 不整合が生じるあいまいな状態を避けるため、先に保存してから操作するよう案内する
  // （developer 判断。無確認でのデータ破棄/不整合を避ける）。
  const isOpenAndDirty = useCallback(
    (memoName: string): boolean =>
      !!openMemo && !!selectedTabId && openMemo.tabId === selectedTabId && openMemo.memoName === memoName && dirty,
    [openMemo, selectedTabId, dirty]
  );

  const handleRequestEncrypt = useCallback(
    (memoName: string) => {
      if (!selectedTabId) return;
      if (isOpenAndDirty(memoName)) {
        setStatusMessage('未保存の変更を保存してから暗号化してください。');
        return;
      }
      setCryptoDialog({ mode: 'setup', tabId: selectedTabId, memoName });
      setCryptoDialogError(null);
    },
    [selectedTabId, isOpenAndDirty]
  );

  const handleRequestDecrypt = useCallback(
    (memoName: string) => {
      if (!selectedTabId) return;
      if (isOpenAndDirty(memoName)) {
        setStatusMessage('未保存の変更を保存してから暗号化を解除してください。');
        return;
      }
      setCryptoDialog({ mode: 'unlockToDecrypt', tabId: selectedTabId, memoName });
      setCryptoDialogError(null);
    },
    [selectedTabId, isOpenAndDirty]
  );

  const handleRequestChangePassword = useCallback(
    (memoName: string) => {
      if (!selectedTabId) return;
      if (isOpenAndDirty(memoName)) {
        setStatusMessage('未保存の変更を保存してからパスワードを変更してください。');
        return;
      }
      setCryptoDialog({ mode: 'changePassword', tabId: selectedTabId, memoName });
      setCryptoDialogError(null);
    },
    [selectedTabId, isOpenAndDirty]
  );

  const handleCryptoDialogCancel = useCallback(() => {
    setCryptoDialog(null);
    setCryptoDialogError(null);
  }, []);

  /**
   * 構造的な暗号操作（暗号化/暗号化解除/パスワード変更）の成功直後、対象メモが現在開いていれば
   * 表示状態を最新化する。操作前に isOpenAndDirty で dirty をブロック済みなので、ここでの
   * 対象は未編集（保存済み）の表示状態のみ。
   * - 暗号化/パスワード変更後（`newEncrypted=true`）: `.txtenc` の本文は `memo:read` では
   *   取得できないため hash のみ更新する（表示中の内容は未編集のまま変わらない。セッション鍵は
   *   main 側の各ハンドラが既に更新/設定済み）。
   * - 暗号化解除後（`newEncrypted=false`）: 平文として通常どおり読み直す。
   * 想定外に読み直しが失敗した場合（直後に外部で削除された等）は安全側でメモを閉じる。
   */
  const refreshOpenMemoAfterCryptoOp = useCallback(
    async (tabId: string, memoName: string, newEncrypted: boolean): Promise<void> => {
      if (!openMemo || openMemo.tabId !== tabId || openMemo.memoName !== memoName) return;
      const res = await ipc.readMemo({ tabId, memoName });
      if (!res.ok) {
        clearEncryptedAutosaveTimer();
        clearPlainAutosaveTimer();
        clearAutoRenameTimer();
        autoRenameBaselineRef.current = null;
        setOpenMemo(null);
        setContentLF('');
        setDirty(false);
        setEditorStats(null);
        setConflictInfo(null);
        reportActiveMemo(null);
        return;
      }
      if (newEncrypted) {
        // 暗号化された（AutoReName 対象外へ移行, DESIGN §2.2/§2.9）。保留中の平文自動保存/
        // AutoReName タイマーは実行時ガード（om.encrypted チェック）で安全に無視されるが、
        // 明示的に解除しておく（M7, developer 判断）。
        clearPlainAutosaveTimer();
        clearAutoRenameTimer();
        autoRenameBaselineRef.current = null;
        setOpenMemo((prev) => (prev ? { ...prev, encrypted: true, lastKnownHash: res.value.hash } : prev));
      } else {
        // 暗号化解除（平文へ復帰）。AutoReName の判定基準を復帰後の本文へ引き直す（M7）。
        autoRenameBaselineRef.current = computeFirstNonEmptyLine(res.value.contentLF);
        setOpenMemo(createOpenMemoState(tabId, memoName, res.value));
        setContentLF(res.value.contentLF);
      }
    },
    [openMemo, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer, clearAutoRenameTimer]
  );

  const handleCryptoDialogSubmit = useCallback(
    (values: PasswordDialogSubmitValues) => {
      if (!cryptoDialog) return;
      const { mode, tabId, memoName } = cryptoDialog;
      void (async () => {
        if (mode === 'setup') {
          const res = await ipc.encryptMemo({ tabId, memoName, password: values.password ?? '', hint: values.hint });
          if (res.ok) {
            setCryptoDialog(null);
            setStatusMessage(`「${memoName}」を暗号化しました。`);
            await refreshOpenMemoAfterCryptoOp(tabId, memoName, true);
            await refreshTree(tabId);
          } else {
            setCryptoDialogError(res.error.message);
          }
          return;
        }
        if (mode === 'unlockToOpen') {
          const res = await ipc.openEncryptedMemo({ tabId, memoName, password: values.password ?? '' });
          if (res.ok) {
            setCryptoDialog(null);
            setCryptoDialogError(null);
            setOpenMemo({ tabId, memoName, eol: res.value.eol, encoding: 'utf-8', lastKnownHash: res.value.hash, encrypted: true });
            setContentLF(res.value.contentLF);
            setDirty(false);
            setEditorStats(null);
            setStatusMessage(null);
            setRevealTarget(null);
            setConflictInfo(null);
            setReloadGeneration((g) => g + 1);
            reportActiveMemo({ tabId, memoName, dirty: false });
          } else {
            setCryptoDialogError(res.error.message);
          }
          return;
        }
        if (mode === 'unlockToDecrypt') {
          const res = await ipc.decryptMemoToPlain({ tabId, memoName, password: values.password ?? '' });
          if (res.ok) {
            setCryptoDialog(null);
            setStatusMessage(`「${memoName}」の暗号化を解除しました。`);
            await refreshOpenMemoAfterCryptoOp(tabId, memoName, false);
            await refreshTree(tabId);
          } else {
            setCryptoDialogError(res.error.message);
          }
          return;
        }
        // mode === 'changePassword'
        const res = await ipc.changeMemoPassword({
          tabId,
          memoName,
          oldPassword: values.oldPassword ?? '',
          newPassword: values.newPassword ?? ''
        });
        if (res.ok) {
          setCryptoDialog(null);
          setStatusMessage(`「${memoName}」のパスワードを変更しました。`);
          await refreshOpenMemoAfterCryptoOp(tabId, memoName, true);
        } else {
          setCryptoDialogError(res.error.message);
        }
      })();
    },
    [cryptoDialog, refreshTree, refreshOpenMemoAfterCryptoOp]
  );

  // --- ツリー開閉/ラベル（tree:updateStructure, メタのみ更新） ---

  const persistTreeStructure = useCallback(
    async (nextTree: TreeNode[]) => {
      if (!selectedTabId) return;
      setTree(nextTree);
      const res = await ipc.updateTreeStructure({ tabId: selectedTabId, treeStructure: toMetaTree(nextTree) });
      if (!res.ok) {
        setStatusMessage(`ツリー更新エラー[${res.error.code}]: ${res.error.message}`);
        await refreshTree(selectedTabId);
      }
    },
    [selectedTabId, refreshTree]
  );

  const handleToggleExpand = useCallback(
    (memoName: string) => {
      void persistTreeStructure(updateTreeNode(tree, memoName, (n) => ({ ...n, expanded: !n.expanded })));
    },
    [tree, persistTreeStructure]
  );

  const handleRequestSetLabel = useCallback(
    (memoName: string, color: string | null) => {
      void persistTreeStructure(
        updateTreeNode(tree, memoName, (n) => ({ ...n, label: { color, kind: n.label?.kind ?? null } }))
      );
    },
    [tree, persistTreeStructure]
  );

  // --- 同一タブ内 DND（並べ替え・階層変更はメタのみ、コピーは memo:move） ---

  const handleLocalMove = useCallback(
    async (draggedNames: string[], destAnchorMemoName: string, zone: DropZone) => {
      if (!selectedTabId) return;
      const metaTree = toMetaTree(tree);
      for (const name of draggedNames) {
        if (name === destAnchorMemoName || isDescendantOf(metaTree, name, destAnchorMemoName)) {
          setStatusMessage('選択したメモ自身またはその子孫へは移動できません。');
          return;
        }
      }
      const movedNodes: MetaTreeNode[] = [];
      for (const name of draggedNames) {
        const node = removeTreeNode(metaTree, name);
        if (node) movedNodes.push(node);
      }
      const position = dropZoneToPosition(zone);
      // reviewer 指摘 M2-R1-02: 'after' は反復順のまま挿入すると選択順が反転するため、
      // orderForBatchInsert で反復順序を補正する（before/child は順反復のままでよい）。
      for (const node of orderForBatchInsert(movedNodes, position)) {
        insertTreeNode(metaTree, node, position, destAnchorMemoName);
      }
      const res = await ipc.updateTreeStructure({ tabId: selectedTabId, treeStructure: metaTree });
      if (res.ok) {
        await refreshTree(selectedTabId);
      } else {
        setStatusMessage(`移動エラー[${res.error.code}]: ${res.error.message}`);
      }
    },
    [tree, selectedTabId, refreshTree]
  );

  const handleLocalCopy = useCallback(
    async (draggedNames: string[], destAnchorMemoName: string, zone: DropZone) => {
      if (!selectedTabId) return;
      const res = await ipc.moveMemo({
        srcTabId: selectedTabId,
        memoNames: draggedNames,
        destTabId: selectedTabId,
        destPosition: dropZoneToPosition(zone),
        destAnchorMemoName,
        copy: true
      });
      if (res.ok) {
        await refreshTree(selectedTabId);
      } else {
        setStatusMessage(`コピーエラー[${res.error.code}]: ${res.error.message}`);
      }
    },
    [selectedTabId, refreshTree]
  );

  // --- タブ間 DND（TabBar へのドロップ, memo:move） ---

  const handleDropMemoOnTab = useCallback(
    async (destTabId: string, payload: MemoDragPayload, copy: boolean) => {
      if (payload.srcTabId === destTabId) return; // 同一タブへのドロップはツリー内 DND 側で処理済み。
      const res = await ipc.moveMemo({
        srcTabId: payload.srcTabId,
        memoNames: payload.memoNames,
        destTabId,
        destPosition: 'last',
        copy
      });
      if (res.ok) {
        setStatusMessage(copy ? 'コピーしました。' : '移動しました。');
        if (selectedTabId === payload.srcTabId || selectedTabId === destTabId) {
          await refreshTree(selectedTabId as string);
        }
      } else {
        setStatusMessage(`移動/コピーエラー[${res.error.code}]: ${res.error.message}`);
      }
    },
    [selectedTabId, refreshTree]
  );

  // --- メモ 追加位置/リネーム/複製/削除（PLAN §2.2） ---

  const handleRequestCreate = useCallback(
    (position: AddPosition, anchorMemoName?: string) => {
      if (!selectedTabId) return;
      setNameDialog({
        title: '新規メモ作成',
        label: 'メモ名',
        submitLabel: '作成',
        onSubmit: (name) => {
          setNameDialog(null);
          void (async () => {
            const res = await ipc.createMemo({ tabId: selectedTabId, name, position, anchorMemoName });
            if (res.ok) {
              setStatusMessage(`メモを作成しました: ${res.value.memoName}`);
              await refreshTree(selectedTabId);
            } else {
              setStatusMessage(`メモ作成エラー[${res.error.code}]: ${res.error.message}`);
            }
          })();
        }
      });
    },
    [selectedTabId, refreshTree]
  );

  const handleRequestRename = useCallback(
    (oldName: string) => {
      if (!selectedTabId) return;
      setNameDialog({
        title: 'メモ名を変更',
        label: '新しいメモ名',
        initialValue: oldName,
        submitLabel: '変更',
        onSubmit: (newName) => {
          setNameDialog(null);
          if (newName === oldName) return;
          void (async () => {
            const res = await ipc.renameMemo({ tabId: selectedTabId, oldName, newName });
            if (res.ok) {
              setStatusMessage(`リネームしました: ${oldName} → ${newName}`);
              if (openMemo?.tabId === selectedTabId && openMemo.memoName === oldName) {
                setOpenMemo({ ...openMemo, memoName: newName });
                reportActiveMemo({ tabId: selectedTabId, memoName: newName, dirty: dirtyRef.current });
              }
              await refreshTree(selectedTabId);
            } else {
              setStatusMessage(`リネームエラー[${res.error.code}]: ${res.error.message}`);
            }
          })();
        }
      });
    },
    [selectedTabId, openMemo, refreshTree, reportActiveMemo]
  );

  const handleRequestDuplicate = useCallback(
    (memoName: string) => {
      if (!selectedTabId) return;
      void (async () => {
        const res = await ipc.duplicateMemo({ tabId: selectedTabId, memoName });
        if (res.ok) {
          setStatusMessage(`複製しました: ${res.value.memoName}`);
          await refreshTree(selectedTabId);
        } else {
          setStatusMessage(`複製エラー[${res.error.code}]: ${res.error.message}`);
        }
      })();
    },
    [selectedTabId, refreshTree]
  );

  const handleRequestDelete = useCallback(
    (memoNames: string[]) => {
      if (!selectedTabId || memoNames.length === 0) return;
      setConfirmDialog({
        title: 'メモを削除',
        message: `以下 ${memoNames.length} 件のメモをごみ箱へ送ります。よろしいですか？\n${memoNames.join(', ')}`,
        confirmLabel: '削除',
        danger: true,
        onConfirm: () => {
          setConfirmDialog(null);
          void (async () => {
            const res = await ipc.deleteMemo({ tabId: selectedTabId, memoNames });
            if (res.ok) {
              setStatusMessage('削除しました。');
              if (openMemo && memoNames.includes(openMemo.memoName)) {
                clearEncryptedAutosaveTimer();
                clearPlainAutosaveTimer();
                clearAutoRenameTimer();
                autoRenameBaselineRef.current = null;
                setOpenMemo(null);
                setContentLF('');
                setDirty(false);
                setEditorStats(null);
                setConflictInfo(null);
                reportActiveMemo(null);
              }
              setSelection(EMPTY_SELECTION);
            } else if (res.error.code !== 'TRASH_FAILED') {
              // TRASH_FAILED は evt:trashFallback 経由の確認ダイアログ側で扱う。
              setStatusMessage(`削除エラー[${res.error.code}]: ${res.error.message}`);
            }
            await refreshTree(selectedTabId);
          })();
        }
      });
    },
    [selectedTabId, openMemo, refreshTree, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer, clearAutoRenameTimer]
  );

  const handleTrashFallbackConfirm = useCallback(() => {
    if (!trashFallback) return;
    const payload = trashFallback;
    setTrashFallback(null);
    void (async () => {
      const res = await ipc.deleteMemo({ tabId: payload.tabId, memoNames: payload.memoNames, forceDirect: true });
      if (res.ok) {
        setStatusMessage('直接削除しました。');
        if (openMemo && payload.memoNames.includes(openMemo.memoName)) {
          clearEncryptedAutosaveTimer();
          clearPlainAutosaveTimer();
          clearAutoRenameTimer();
          autoRenameBaselineRef.current = null;
          setOpenMemo(null);
          setContentLF('');
          setDirty(false);
          setEditorStats(null);
          setConflictInfo(null);
          reportActiveMemo(null);
        }
      } else {
        setStatusMessage(`直接削除エラー[${res.error.code}]: ${res.error.message}`);
      }
      if (selectedTabId === payload.tabId) await refreshTree(payload.tabId);
    })();
  }, [trashFallback, selectedTabId, openMemo, refreshTree, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer, clearAutoRenameTimer]);

  // --- タブ操作（PLAN §2.1） ---

  const handleRequestRegisterTab = useCallback(() => {
    const folderPath = window.prompt('登録するフォルダの絶対パス');
    if (!folderPath || !folderPath.trim()) return;
    void (async () => {
      const res = await ipc.registerTab({ folderPath: folderPath.trim() });
      if (res.ok) {
        setStatusMessage(`タブを登録しました: ${res.value.name}`);
        await refreshTabs();
      } else {
        setStatusMessage(`タブ登録エラー[${res.error.code}]: ${res.error.message}`);
      }
    })();
  }, [refreshTabs]);

  const handleDropExternalFolder = useCallback(
    (folderPath: string) => {
      void (async () => {
        const res = await ipc.registerTab({ folderPath });
        if (res.ok) {
          setStatusMessage(`タブを登録しました: ${res.value.name}`);
          await refreshTabs();
        } else {
          setStatusMessage(`タブ登録エラー[${res.error.code}]: ${res.error.message}`);
        }
      })();
    },
    [refreshTabs]
  );

  const handleRequestCreateTab = useCallback(() => {
    const parentDir = window.prompt('新規タブ（フォルダ）を作成する親フォルダの絶対パス');
    if (!parentDir || !parentDir.trim()) return;
    setNameDialog({
      title: '新規タブ作成',
      label: 'タブ（フォルダ）名',
      submitLabel: '作成',
      onSubmit: (name) => {
        setNameDialog(null);
        void (async () => {
          const res = await ipc.createTab({ parentDir: parentDir.trim(), name });
          if (res.ok) {
            setStatusMessage(`新規タブを作成しました: ${res.value.name}`);
            await refreshTabs();
          } else {
            setStatusMessage(`タブ作成エラー[${res.error.code}]: ${res.error.message}`);
          }
        })();
      }
    });
  }, [refreshTabs]);

  const handleRequestRenameTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      setNameDialog({
        title: 'タブ名を変更',
        label: '新しいタブ名',
        initialValue: tab?.name ?? '',
        submitLabel: '変更',
        onSubmit: (name) => {
          setNameDialog(null);
          void (async () => {
            const res = await ipc.renameTab({ tabId, newName: name });
            if (res.ok) {
              setStatusMessage('タブ名を変更しました。');
              await refreshTabs();
            } else {
              setStatusMessage(`タブ名変更エラー[${res.error.code}]: ${res.error.message}`);
            }
          })();
        }
      });
    },
    [tabs, refreshTabs]
  );

  const handleRequestRemoveTab = useCallback(
    (tabId: string, deleteFolder: boolean) => {
      const tab = tabs.find((t) => t.id === tabId);
      setConfirmDialog({
        title: 'タブを削除',
        message: deleteFolder
          ? `「${tab?.name ?? tabId}」のフォルダをごみ箱へ送り、タブ登録を解除します。よろしいですか？`
          : `「${tab?.name ?? tabId}」の登録を解除します（フォルダ自体は削除しません）。よろしいですか？`,
        confirmLabel: deleteFolder ? 'ごみ箱へ送って削除' : '登録解除',
        danger: deleteFolder,
        onConfirm: () => {
          setConfirmDialog(null);
          void (async () => {
            const res = await ipc.removeTab({ tabId, deleteFolder });
            if (res.ok) {
              setStatusMessage(deleteFolder ? 'タブとフォルダを削除しました。' : 'タブの登録を解除しました。');
              if (selectedTabId === tabId) {
                clearEncryptedAutosaveTimer();
                clearPlainAutosaveTimer();
                clearAutoRenameTimer();
                autoRenameBaselineRef.current = null;
                setSelectedTabId(null);
                setTree([]);
                setOpenMemo(null);
                setContentLF('');
                setDirty(false);
                setEditorStats(null);
                setConflictInfo(null);
                reportActiveMemo(null);
              }
              await refreshTabs();
            } else {
              setStatusMessage(`タブ削除エラー[${res.error.code}]: ${res.error.message}`);
            }
          })();
        }
      });
    },
    [tabs, selectedTabId, refreshTabs, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer, clearAutoRenameTimer]
  );

  const handleReorderTabs = useCallback(
    (orderedTabIds: string[]) => {
      setTabs((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t] as const));
        return orderedTabIds.map((id) => byId.get(id)).filter((t): t is TabInfo => t !== undefined);
      });
      void (async () => {
        const res = await ipc.reorderTabs({ orderedTabIds });
        if (!res.ok) {
          setStatusMessage(`並べ替えエラー[${res.error.code}]: ${res.error.message}`);
          await refreshTabs();
        }
      })();
    },
    [refreshTabs]
  );

  const handleSplitterPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (e: PointerEvent): void => {
      const bodyEl = bodyRef.current;
      if (!bodyEl) return;
      const bodyLeft = bodyEl.getBoundingClientRect().left;
      const nextWidth = Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, e.clientX - bodyLeft));
      setTreeWidth(nextWidth);
    };
    const handlePointerUp = (): void => setDragging(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragging]);

  // Ctrl+ホイールでのフォント/文字サイズ変更（DESIGN §2.3）。React の合成 onWheel は
  // wheel イベントを passive 登録するため preventDefault が効かず、Electron 既定の
  // ページズーム（Ctrl+ホイール）を止められない。ネイティブ addEventListener を
  // `{ passive: false }` で登録し、確実に preventDefault する。エディタ枠は openMemo の
  // 有無で mount/unmount されるため（DOM ノードが差し替わるため）useEffect ではなく
  // callback ref でその都度リスナーを張り直す。
  const setEditorWrapNode = useCallback((node: HTMLDivElement | null) => {
    if (editorWheelCleanup.current) {
      editorWheelCleanup.current();
      editorWheelCleanup.current = null;
    }
    if (!node) return;

    const handleWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setEditorSettings((prev) => {
        const next = clampFontSize(prev.fontSize + (e.deltaY < 0 ? FONT_SIZE_STEP : -FONT_SIZE_STEP));
        if (next === prev.fontSize) return prev;
        if (fontSizePersistTimer.current) clearTimeout(fontSizePersistTimer.current);
        fontSizePersistTimer.current = setTimeout(() => {
          void ipc
            .setSettings({ editorDefaults: { fontSize: next } })
            .catch((err: unknown) => console.error('settings:set (fontSize) failed', err));
        }, FONT_SIZE_PERSIST_DEBOUNCE_MS);
        return { ...prev, fontSize: next };
      });
    };

    node.addEventListener('wheel', handleWheel, { passive: false });
    editorWheelCleanup.current = () => node.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(
    () => () => {
      if (fontSizePersistTimer.current) clearTimeout(fontSizePersistTimer.current);
      if (editorWheelCleanup.current) editorWheelCleanup.current();
    },
    []
  );

  // グローバルショートカット（M7, AppSettings.shortcuts / shared/shortcuts.ts。CodeMirror 内蔵の
  // ショートカット=保存 Ctrl+S・検索 Ctrl+F 等はエディタ自身のキーマップが処理するため対象外、
  // shortcuts.ts 冒頭コメント参照）。設定変更を都度反映できるよう `shortcuts` state を deps に含める。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (matchesShortcut(e, shortcuts.globalSearch ?? DEFAULT_SHORTCUTS.globalSearch)) {
        e.preventDefault();
        setShowSearchPanel(true);
        return;
      }
      if (matchesShortcut(e, shortcuts.toggleTheme ?? DEFAULT_SHORTCUTS.toggleTheme)) {
        e.preventDefault();
        handleToggleTheme();
        return;
      }
      if (matchesShortcut(e, shortcuts.openSettings ?? DEFAULT_SHORTCUTS.openSettings)) {
        e.preventDefault();
        setShowSettingsDialog(true);
        return;
      }
      if (matchesShortcut(e, shortcuts.lockCurrentMemo ?? DEFAULT_SHORTCUTS.lockCurrentMemo)) {
        const om = openMemoRef.current;
        if (om && om.encrypted) {
          e.preventDefault();
          void handleLockMemo();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, handleToggleTheme, handleLockMemo]);

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        selectedTabId={selectedTabId}
        onSelectTab={(tabId) => void selectTab(tabId)}
        onReorder={handleReorderTabs}
        onRequestRegister={handleRequestRegisterTab}
        onRequestCreate={handleRequestCreateTab}
        onRequestRename={handleRequestRenameTab}
        onRequestRemove={handleRequestRemoveTab}
        onDropMemo={(destTabId, payload, copy) => void handleDropMemoOnTab(destTabId, payload, copy)}
        onDropExternalFolder={handleDropExternalFolder}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onRequestSearch={() => setShowSearchPanel(true)}
      />
      <div className="app__body" ref={bodyRef}>
        <div className="app__pane app__tree" style={{ width: treeWidth }}>
          {selectedTabId ? (
            <Tree
              tabId={selectedTabId}
              tree={tree}
              openMemoName={openMemo?.memoName ?? null}
              selection={selection}
              onSelectionChange={setSelection}
              onOpenMemo={(memoName, encrypted) => void openMemoByName(memoName, encrypted)}
              onToggleExpand={handleToggleExpand}
              onRequestCreate={handleRequestCreate}
              onRequestRename={handleRequestRename}
              onRequestDuplicate={handleRequestDuplicate}
              onRequestDelete={handleRequestDelete}
              onRequestSetLabel={handleRequestSetLabel}
              onRequestEncrypt={handleRequestEncrypt}
              onRequestDecrypt={handleRequestDecrypt}
              onRequestChangePassword={handleRequestChangePassword}
              onLocalMove={(names, anchor, zone) => void handleLocalMove(names, anchor, zone)}
              onLocalCopy={(names, anchor, zone) => void handleLocalCopy(names, anchor, zone)}
            />
          ) : (
            <span className="app__tree-placeholder">タブを選択、または新規作成してください。</span>
          )}
        </div>
        <div
          className={`app__splitter${dragging ? ' app__splitter--dragging' : ''}`}
          onPointerDown={handleSplitterPointerDown}
        />
        <div className="app__pane app__editor">
          {openMemo ? (
            <div className="app__editor-inner" ref={setEditorWrapNode}>
              <div className="app__editor-toolbar">
                <span>
                  {openMemo.memoName}
                  {dirty ? ' *' : ''}
                </span>
                <span className="app__editor-meta">
                  {openMemo.encrypted ? '🔒 暗号化' : `encoding: ${openMemo.encoding}`} / eol: {openMemo.eol}
                </span>
                <button type="button" onClick={() => void handleSave()} disabled={!dirty}>
                  保存
                </button>
                {openMemo.encrypted && (
                  <button type="button" onClick={() => void handleLockMemo()}>
                    ロック
                  </button>
                )}
              </div>
              <CodeMirrorEditor
                key={`${openMemo.tabId}:${openMemo.memoName}:${reloadGeneration}`}
                initialContentLF={contentLF}
                onChange={handleEditorChange}
                onStats={handleEditorStats}
                onSave={() => void handleSave()}
                settings={editorSettings}
                revealTarget={revealTarget}
                readOnly={
                  (conflictInfo !== null && conflictInfo.tabId === openMemo.tabId && conflictInfo.memoName === openMemo.memoName) ||
                  (cryptoDialog !== null && cryptoDialog.tabId === openMemo.tabId && cryptoDialog.memoName === openMemo.memoName)
                }
                linkOpenTrigger={linkSettings.openTrigger}
                onLinkClick={handleLinkClick}
              />
            </div>
          ) : (
            <span className="app__editor-placeholder">
              左のツリーからメモを選択してください。
            </span>
          )}
        </div>
      </div>
      <StatusBar
        theme={theme}
        appInfo={appInfo}
        editorStats={editorStats}
        fontSize={editorSettings.fontSize}
        statusMessage={statusMessage}
        onOpenSettings={() => setShowSettingsDialog(true)}
      />

      {nameDialog && (
        <NameInputDialog
          title={nameDialog.title}
          label={nameDialog.label}
          initialValue={nameDialog.initialValue}
          submitLabel={nameDialog.submitLabel}
          onSubmit={nameDialog.onSubmit}
          onCancel={() => setNameDialog(null)}
        />
      )}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          danger={confirmDialog.danger}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
      {trashFallback && (
        <ConfirmDialog
          title="直接削除の確認"
          message={`ごみ箱へ送れませんでした（${trashFallback.reason}）。直接削除しますか？\n${trashFallback.memoNames.join(', ')}`}
          confirmLabel="直接削除"
          danger
          onConfirm={handleTrashFallbackConfirm}
          onCancel={() => setTrashFallback(null)}
        />
      )}
      {conflictInfo && openMemo && conflictInfo.tabId === openMemo.tabId && conflictInfo.memoName === openMemo.memoName && (
        <ConflictDialog
          memoName={conflictInfo.memoName}
          onKeepMine={handleConflictKeepMine}
          onAdoptExternal={handleConflictAdoptExternal}
        />
      )}
      {cryptoDialog && (
        <PasswordDialog
          mode={cryptoDialog.mode}
          memoName={cryptoDialog.memoName}
          errorMessage={cryptoDialogError}
          onCancel={handleCryptoDialogCancel}
          onSubmit={handleCryptoDialogSubmit}
        />
      )}
      {showSearchPanel && (
        <SearchPanel
          tabs={tabs}
          currentTabId={selectedTabId}
          onClose={() => setShowSearchPanel(false)}
          onJump={(hit) => void handleJumpToHit(hit)}
        />
      )}
      {showSettingsDialog && (
        <SettingsDialog
          theme={theme}
          onToggleTheme={handleToggleTheme}
          editorSettings={editorSettings}
          onChangeEditorSettings={handleChangeEditorSettingsFromDialog}
          linkSettings={linkSettings}
          onChangeLinks={handleChangeLinksFromDialog}
          autosave={autosaveSettings}
          onChangeAutosave={handleChangeAutosaveFromDialog}
          eolPolicy={eolPolicy}
          onChangeEolPolicy={handleChangeEolPolicyFromDialog}
          shortcuts={shortcuts}
          onChangeShortcut={handleChangeShortcutFromDialog}
          onClose={() => setShowSettingsDialog(false)}
        />
      )}
    </div>
  );
}
