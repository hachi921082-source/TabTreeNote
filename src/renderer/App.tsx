import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ipc } from './ipc';
import { useTheme } from './theme/useTheme';
import { createOpenMemoState, withUpdatedHash, type OpenMemoState } from './editor/eolKeeper';
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings, type EditorStats } from './editor/codeMirrorSetup';
import { CodeMirrorEditor, type RevealTarget } from './components/Editor/CodeMirrorEditor';
import { TabBar } from './components/TabBar/TabBar';
import { Tree } from './components/Tree/Tree';
import { NameInputDialog } from './components/dialogs/NameInputDialog';
import { ConfirmDialog } from './components/dialogs/ConfirmDialog';
import { ConflictDialog } from './components/dialogs/ConflictDialog';
import { SearchPanel } from './components/Search/SearchPanel';
import { EMPTY_SELECTION, type SelectionState } from './store/selection';
import {
  dropZoneToPosition,
  toMetaTree,
  updateTreeNode,
  type DropZone,
  type MemoDragPayload
} from './components/Tree/treeView';
import { insertTreeNode, isDescendantOf, orderForBatchInsert, removeTreeNode } from '@shared/treeOps';
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
import type { MetaTreeNode, SearchHit, TabInfo, TreeNode } from '@shared/models';

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

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogRequest | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogRequest | null>(null);
  const [trashFallback, setTrashFallback] = useState<TrashFallbackPayload | null>(null);
  // 外部変更との競合（M4, DESIGN §3.3）。表示中はエディタ入力・保存をロックする。
  const [conflictInfo, setConflictInfo] = useState<{ tabId: string; memoName: string } | null>(null);
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
        const res = await ipc.readMemo({ tabId: om.tabId, memoName: om.memoName });
        if (!res.ok) return;
        setOpenMemo(createOpenMemoState(om.tabId, om.memoName, res.value));
        setContentLF(res.value.contentLF);
        setDirty(false);
        setEditorStats(null);
        setReloadGeneration((g) => g + 1);
        reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: false });
        setStatusMessage(`「${om.memoName}」の外部変更を反映しました。`);
      })();
    });

    return () => {
      unsubscribeConflict();
      unsubscribeExternalChange();
    };
  }, [refreshTree, reportActiveMemo]);

  // 競合ダイアログの解決アクション（M4）。
  const handleConflictKeepMine = useCallback(() => {
    if (!conflictInfo || !openMemo) {
      setConflictInfo(null);
      return;
    }
    void (async () => {
      // expectedHash を渡さず（=競合チェックを迂回して）強制上書きする。ユーザーが競合
      // ダイアログで明示的に選んだ意図的な上書きであり、既存の memo:save 競合チェックの
      // バイパスは本ケースに限定される（DESIGN §3.3）。
      const res = await ipc.saveMemo({
        tabId: openMemo.tabId,
        memoName: openMemo.memoName,
        contentLF,
        eol: openMemo.eol,
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
      const res = await ipc.readMemo({ tabId, memoName });
      if (res.ok) {
        setOpenMemo(createOpenMemoState(tabId, memoName, res.value));
        setContentLF(res.value.contentLF);
        setDirty(false);
        setEditorStats(null);
        setReloadGeneration((g) => g + 1);
        reportActiveMemo({ tabId, memoName, dirty: false });
        setStatusMessage(`「${memoName}」の外部変更を反映しました。`);
      } else {
        // 外部で削除されていた場合など。メモを閉じる。
        setOpenMemo(null);
        setContentLF('');
        setDirty(false);
        setEditorStats(null);
        reportActiveMemo(null);
        setStatusMessage(`「${memoName}」は外部で削除されました。`);
      }
      setConflictInfo(null);
    })();
  }, [conflictInfo, reportActiveMemo]);

  const handleToggleTheme = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    void ipc.setSettings({ theme: next }).catch((e: unknown) => console.error('settings:set failed', e));
  }, [theme, setTheme]);

  const selectTab = useCallback(async (tabId: string) => {
    // dirtyRef.current で常に最新値を参照する（M2-R1-01 対応。useCallback の deps には
    // 含めない＝コールバック identity は refreshTree のみに依存させたまま最新 dirty を読める）。
    if (dirtyRef.current && !window.confirm('未保存の変更があります。破棄して別のタブを開きますか？')) {
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
  }, [refreshTree, reportActiveMemo]);

  const openMemoByName = useCallback(
    async (memoName: string, encrypted: boolean) => {
      if (!selectedTabId) return;
      // dirtyRef.current で常に最新値を参照する（M2-R1-01 対応、上記 selectTab と同様）。
      if (dirtyRef.current && !window.confirm('未保存の変更があります。破棄して別のメモを開きますか？')) {
        return;
      }
      if (encrypted) {
        setStatusMessage('暗号化メモの復号は M6 で対応予定です（現時点では名前のみ表示）。');
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
        reportActiveMemo({ tabId: selectedTabId, memoName, dirty: false });
      } else {
        setStatusMessage(`メモ読込エラー: ${res.error.message}`);
      }
    },
    [selectedTabId, reportActiveMemo]
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
      } else if (dirtyRef.current && !window.confirm('未保存の変更があります。破棄して別のメモを開きますか？')) {
        // 同一タブ内で別メモへジャンプする場合は openMemoByName と同様の未保存確認ガード。
        return;
      }

      if (hit.encrypted) {
        setStatusMessage(`「${hit.memoName}」は暗号化メモのため、本文プレビュー・ジャンプは非対応です（M6で対応予定）。`);
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
      reportActiveMemo({ tabId: hit.tabId, memoName: hit.memoName, dirty: false });
      if (hit.matchField === 'body' && hit.matchStart !== undefined && hit.matchEnd !== undefined) {
        revealTokenRef.current += 1;
        setRevealTarget({ from: hit.matchStart, to: hit.matchEnd, token: revealTokenRef.current });
      }
    },
    [selectTab, reportActiveMemo]
  );

  // 全文検索パネルのショートカット（Ctrl+Shift+F）。CodeMirror 側の Ctrl+F（現在メモ内検索,
  // @codemirror/search）とはキーが異なるため衝突しない。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearchPanel(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // CodeMirrorEditor（非制御）からの通知。doc 変更のたびに contentLF を最新化する。
  const handleEditorChange = useCallback(
    (content: string) => {
      setContentLF(content);
      setDirty(true);
      const om = openMemoRef.current;
      if (om) reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: true });
    },
    [reportActiveMemo]
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
    const res = await ipc.saveMemo({
      tabId: openMemo.tabId,
      memoName: openMemo.memoName,
      contentLF,
      eol: openMemo.eol,
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
  }, [openMemo, contentLF, dirty, conflictInfo, reportActiveMemo]);

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
    [selectedTabId, openMemo, refreshTree, reportActiveMemo]
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
  }, [trashFallback, selectedTabId, openMemo, refreshTree, reportActiveMemo]);

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
    [tabs, selectedTabId, refreshTabs, reportActiveMemo]
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
                  encoding: {openMemo.encoding} / eol: {openMemo.eol}
                </span>
                <button type="button" onClick={() => void handleSave()} disabled={!dirty}>
                  保存
                </button>
              </div>
              <CodeMirrorEditor
                key={`${openMemo.tabId}:${openMemo.memoName}:${reloadGeneration}`}
                initialContentLF={contentLF}
                onChange={handleEditorChange}
                onStats={handleEditorStats}
                onSave={() => void handleSave()}
                settings={editorSettings}
                revealTarget={revealTarget}
                readOnly={conflictInfo !== null && conflictInfo.tabId === openMemo.tabId && conflictInfo.memoName === openMemo.memoName}
              />
            </div>
          ) : (
            <span className="app__editor-placeholder">
              左のツリーからメモを選択してください。
            </span>
          )}
        </div>
      </div>
      <div className="app__statusbar">
        <span>Theme: {theme}</span>
        <span>
          {appInfo ? `v${appInfo.appVersion} / schema ${appInfo.schemaVersion}` : 'app:getInfo 応答待ち…'}
        </span>
        {editorStats && (
          <span className="app__statusbar-editor-stats">
            {editorStats.charCount} 文字 / {editorStats.lineCount} 行 / 行 {editorStats.cursorLine}, 列{' '}
            {editorStats.cursorColumn}
            {editorStats.selectedCharCount > 0 ? ` (選択 ${editorStats.selectedCharCount} 文字)` : ''} / フォント{' '}
            {editorSettings.fontSize}px
          </span>
        )}
        {statusMessage && <span className="app__statusbar-message">{statusMessage}</span>}
      </div>

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
      {showSearchPanel && (
        <SearchPanel
          tabs={tabs}
          currentTabId={selectedTabId}
          onClose={() => setShowSearchPanel(false)}
          onJump={(hit) => void handleJumpToHit(hit)}
        />
      )}
    </div>
  );
}
