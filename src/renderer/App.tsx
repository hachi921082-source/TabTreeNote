import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ipc } from './ipc';
import { useTheme } from './theme/useTheme';
import { createOpenMemoState, resolveEffectiveEol, withUpdatedHash, type OpenMemoState } from './editor/eolKeeper';
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings, type EditorStats } from './editor/codeMirrorSetup';
import { CodeMirrorEditor, type CodeMirrorEditorHandle, type RevealTarget } from './components/Editor/CodeMirrorEditor';
import { MarkdownToolbar } from './components/Editor/MarkdownToolbar';
import type { DetectedLink } from './editor/links';
import type { PendingImageInsert } from './editor/imagePaste';
import { TabBar } from './components/TabBar/TabBar';
import { Tree } from './components/Tree/Tree';
import { NameInputDialog } from './components/dialogs/NameInputDialog';
import { ConfirmDialog } from './components/dialogs/ConfirmDialog';
import { ConflictDialog } from './components/dialogs/ConflictDialog';
import { PasswordDialog, type PasswordDialogMode, type PasswordDialogSubmitValues } from './components/dialogs/PasswordDialog';
import { PropertiesDialog } from './components/dialogs/PropertiesDialog';
import { SearchPanel } from './components/Search/SearchPanel';
import { StatusBar } from './components/StatusBar/StatusBar';
import { SettingsDialog } from './components/Settings/SettingsDialog';
import { EMPTY_SELECTION, selectSingle, type SelectionState } from './store/selection';
import {
  collapseSessionToPlaceholder,
  dropZoneToPosition,
  findSessionRootNode,
  findTreeNode,
  findTreeNodeInScope,
  insertTreeNodeAtInScope,
  removeTreeNodesByNamesInScope,
  toMetaTree,
  updateTreeNode,
  updateTreeNodeInScope,
  type DropZone,
  type MemoDragPayload
} from './components/Tree/treeView';
import { collectTreeNames, insertTreeNode, isDescendantOf, orderForBatchInsert, removeTreeNode } from '@shared/treeOps';
import { DEFAULT_SHORTCUTS, matchesShortcut, type ShortcutAction } from '@shared/shortcuts';
import type {
  AddPosition,
  AppInfo,
  ConflictPayload,
  EditorMenuCommandPayload,
  EditorReportActiveArgs,
  ExternalChangePayload,
  LockContext,
  MarkdownDecorationCommand,
  MemoProperties,
  MetaRecoveredPayload,
  OpErrorPayload,
  ShowPropertiesPayload,
  TrashFallbackPayload
} from '@shared/ipc-contract';
import type { AppSettings, AppSettingsPatch, MetaTreeNode, SearchHit, TabInfo, TreeNode } from '@shared/models';

const MIN_TREE_WIDTH = 160;
const MAX_TREE_WIDTH = 600;
const DEFAULT_TREE_WIDTH = 260;

/**
 * 新規メモの既定名を生成する（ユーザー要望: AutoReName廃止に伴い、名前入力ダイアログを挟まず
 * 「新しいメモ」「新しいメモ(1)」…の形で即作成し、リネームしなければそのままにする）。
 */
function generateDefaultMemoName(existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((n) => n.toUpperCase()));
  const base = '新しいメモ';
  if (!taken.has(base.toUpperCase())) return base;
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base}(${i})`;
    if (!taken.has(candidate.toUpperCase())) return candidate;
  }
  return `${base}(${Date.now()})`;
}

/**
 * v3 M8: `rootMemoName` 自身、またはその配下（子孫）に `targetMemoName` が含まれるか。
 * サブツリーロック実行前に「現在開いているメモがロック対象に含まれないか」を確認するために使う
 * （ロック実行は対象実ファイルを難読化名へリネーム+暗号化するため、開いたままだと開いている
 * エディタが参照している旧ファイル名が消え、表示が破綻するのを防ぐ, developer 判断）。
 */
function treeNodeContains(nodes: readonly TreeNode[], rootMemoName: string, targetMemoName: string): boolean {
  function walk(node: TreeNode): boolean {
    if (node.memoName === targetMemoName) return true;
    return node.children.some(walk);
  }
  const root = findTreeNode(nodes, rootMemoName);
  return root ? walk(root) : false;
}

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
  /** キャンセル時に追加で行いたい処理があれば指定する（例: Promise の resolve）。
   * 未指定の場合は従来通りダイアログを閉じるだけ（既存呼び出し元は挙動不変）。 */
  onCancel?: () => void;
}

export function App() {
  const { theme, setTheme } = useTheme('light');
  const [uiFontScale, setUiFontScale] = useState(1);
  // 常時最前面表示（ユーザー要望）。セッション内のみ（設定への永続化はしない）。
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  // Windowsログイン時の自動起動（ユーザー要望）。状態はOS（レジストリ）が真実源。
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const [dragging, setDragging] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // エディタ右クリックメニューの各種コマンド（元に戻す/変換/チェック等, ユーザー要望）を
  // CodeMirror へ委譲するための ref。
  const editorRef = useRef<CodeMirrorEditorHandle>(null);

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
  // プロパティ画面（ユーザー要望）。表示対象の tabId を保持しておき「ファイルの場所を開く」で使う。
  const [propertiesDialog, setPropertiesDialog] = useState<{ tabId: string; properties: MemoProperties } | null>(null);
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
  // メモを開いた際にエディタへフォーカスを移すかどうか（既定 true）。ツリーの矢印キーによる
  // 連続移動中だけ false で開き、フォーカスをツリー側に残す（ユーザー要望）。CodeMirrorEditor
  // 側はこの値をマウント時に一度だけ読むため、消費後は次回の既定に戻す（下の useEffect）。
  const [editorAutoFocus, setEditorAutoFocus] = useState(true);
  // 未保存の変更を破棄するか確認するダイアログが表示中かどうか（requestCloseCurrentMemo）。
  // 非ブロッキングな ConfirmDialog に変更した際、表示中に別のメモ/タブへの切替を重ねて
  // 要求されても確認ダイアログを二重に出さないためのガード（ユーザー報告バグ対応。
  // window.confirm はブロッキングだったため元々この心配が無かった）。
  const pendingDiscardConfirmRef = useRef(false);
  // 同一メモのまま本文を強制的に再読込させるための世代カウンタ（M4）。CodeMirrorEditor は
  // 非制御コンポーネントで `initialContentLF` はマウント時のみ使用するため、外部変更の
  // 静かな反映・競合解決で本文を書き換える際は key に含めてこの値を進め、明示的に
  // 再マウントさせる（同時に Undo 履歴もリセットされるのが適切、内容が外部由来のため）。
  const [reloadGeneration, setReloadGeneration] = useState(0);

  // --- v3 M10c: Markdownツールバー（ソース/プレビュー切替）---
  // 既定はプレビュー表示（DESIGNv3 §2.1「ライブプレビュー方式をデフォルトにする」）。メモを
  // 切り替えるたびに既定へ戻す（下の effect）。`openMemo.format!=='markdown'` の間は無関係。
  const [previewMode, setPreviewMode] = useState(true);
  useEffect(() => {
    setPreviewMode(true);
  }, [openMemo?.tabId, openMemo?.memoName, reloadGeneration]);

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
      .getOpenAtLogin()
      .then((res) => {
        if (res.ok) setOpenAtLogin(res.value);
      })
      .catch((e: unknown) => console.error('window:getOpenAtLogin failed', e));

    ipc
      .getSettings()
      .then((res) => {
        if (res.ok) {
          setTheme(res.value.theme);
          setUiFontScale(res.value.uiFontScale ?? 1);
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

  // UI（エディタ本文を除く）の文字サイズ倍率を CSS 変数として反映する（theme.css/App.css 側は
  // `calc(Npx * var(--ui-font-scale, 1))` で参照する）。
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font-scale', String(uiFontScale));
  }, [uiFontScale]);

  // 起動時に前回開いていたメモを復元できるよう、メモを開くたびに settings へ記録する
  // （ユーザー要望）。復元自体は openMemoDirect 定義後の別 effect で行う。
  useEffect(() => {
    if (!openMemo) return;
    void ipc
      .setSettings({ lastOpened: { tabId: openMemo.tabId, memoName: openMemo.memoName } })
      .catch((e: unknown) => console.error('settings:set failed', e));
  }, [openMemo?.tabId, openMemo?.memoName]);

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

  // --- 平文メモの自動保存（M7, DESIGN §2.6「適度な自動保存」） ---

  const clearPlainAutosaveTimer = useCallback((): void => {
    if (plainAutosaveTimerRef.current) {
      clearTimeout(plainAutosaveTimerRef.current);
      plainAutosaveTimerRef.current = null;
    }
  }, []);

  /**
   * 現在開いているメモを安全に閉じてよいかを判定し、必要な後始末を行う。
   * - 平文メモ: dirty なら破棄確認ダイアログ（自作 ConfirmDialog）で確認する。
   *   以前は window.confirm を使っていたが、ネイティブモーダル表示中にレンダラーの
   *   JSスレッド/IME合成状態が同期停止し、キャンセル後にIME入力中の文字が入力不能になる
   *   バグがあったため、他の確認ダイアログと同じ非ブロッキングな自作ダイアログに統一した
   *   （ユーザー報告バグ対応）。非ブロッキング化に伴い、表示中に別の切替要求が重ねて来ても
   *   確認ダイアログを二重に出さないよう `pendingDiscardConfirmRef` でガードする。
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
      if (dirtyRef.current) {
        if (pendingDiscardConfirmRef.current) return false;
        pendingDiscardConfirmRef.current = true;
        const discard = await new Promise<boolean>((resolve) => {
          setConfirmDialog({
            title: '未保存の変更',
            message: '未保存の変更があります。破棄して別のメモを開きますか？',
            confirmLabel: '破棄して開く',
            danger: true,
            onConfirm: () => {
              setConfirmDialog(null);
              resolve(true);
            },
            onCancel: () => resolve(false)
          });
        });
        pendingDiscardConfirmRef.current = false;
        if (!discard) return false;
      }
      // 切り替えが確定した時点で平文自動保存の保留タイマーを解除する（M7。キャンセルされた
      // 場合はここへ到達しないため、保留中の自動保存は温存される）。
      clearPlainAutosaveTimer();
      return true;
    }

    // 【v3 M9a】ロック解除セッション配下（om.lockToken あり）は実ファイルこそ .txtenc だが、
    // M6 個別暗号化（sessionKeyStore）とは別物で、既にパスワード入力済みで開封済みのセッション
    // （ノードロックのセッション自体は明示的な操作でのみ破棄される。自動再ロックはしない,
    // DESIGNv3 §1.11）。そのため、ここではメモ切替に伴う「保存」だけ行い、`crypto:lock`（M6の
    // 個別暗号化セッション鍵破棄）は呼ばない（対象が違うため誤り）。自動保存は
    // `schedulePlainAutosave` 側（handleEditorChange）でスケジュールされるため、平文用タイマーを
    // 解除する。
    if (om.lockToken) {
      clearPlainAutosaveTimer();
      if (dirtyRef.current) {
        const res = await ipc.saveMemo({
          tabId: om.tabId,
          memoName: om.memoName,
          contentLF: contentLFRef.current,
          eol: resolveEffectiveEol(om.eol, eolPolicyRef.current),
          encoding: om.encoding,
          expectedHash: om.lastKnownHash,
          lockContext: { lockToken: om.lockToken }
        });
        if (!res.ok) {
          setStatusMessage(`保存に失敗しました[${res.error.code}]: ${res.error.message}`);
          return false;
        }
      }
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
  }, [clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]);

  const performEncryptedAutosave = useCallback(async (): Promise<void> => {
    const om = openMemoRef.current;
    // 【v3 M9a】ロック解除セッション配下（om.lockToken あり）は M6 個別暗号化の低頻度自動保存
    // 対象外（performPlainAutosave 側の lockContext 付き保存を使う）。
    if (!om || !om.encrypted || om.lockToken || !dirtyRef.current) return;
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
      reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: false, format: om.format });
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
    // 【v3 M9a】ロック解除セッション配下（om.lockToken あり）は encrypted===true だが、平文と
    // 同じ `memo:save`（lockContext 付き）で自動保存する（M6 個別暗号化のセッション鍵とは無関係）。
    if (!om || (om.encrypted && !om.lockToken) || !dirtyRef.current) return;
    const conflict = conflictInfoRef.current;
    if (conflict && conflict.tabId === om.tabId && conflict.memoName === om.memoName) return; // 解決中ロック。

    const res = await ipc.saveMemo({
      tabId: om.tabId,
      memoName: om.memoName,
      contentLF: contentLFRef.current,
      eol: resolveEffectiveEol(om.eol, eolPolicyRef.current),
      encoding: om.encoding,
      expectedHash: om.lastKnownHash,
      lockContext: om.lockToken ? { lockToken: om.lockToken } : undefined
    });
    if (res.ok) {
      setOpenMemo((prev) =>
        prev && prev.tabId === om.tabId && prev.memoName === om.memoName ? withUpdatedHash(prev, res.value.savedHash) : prev
      );
      setDirty(false);
      reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: false, format: om.format });
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

  useEffect(() => clearEncryptedAutosaveTimer, [clearEncryptedAutosaveTimer]);
  useEffect(() => clearPlainAutosaveTimer, [clearPlainAutosaveTimer]);

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
        // 【v3 M9a】ロック解除セッション配下（om.lockToken あり）は M6 個別暗号化のセッション鍵
        // （sessionKeyStore）を使っていないため crypto:lock は対象外。平文と同じ静かな読み直しで
        // 扱う（lockContext 付き memo:read）。
        if (om.encrypted && !om.lockToken) {
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
        const res = await ipc.readMemo({
          tabId: om.tabId,
          memoName: om.memoName,
          lockContext: om.lockToken ? { lockToken: om.lockToken } : undefined
        });
        if (!res.ok) return;
        // v3 M10b: 外部内容の静かな反映では拡張子（Markdown属性）自体は変わらないため、直前の
        // om.format をそのまま引き継ぐ（docs/v3/milestones/M10b-markdown-live-preview.md §0.7）。
        setOpenMemo(createOpenMemoState(om.tabId, om.memoName, res.value, om.lockToken, om.format));
        setContentLF(res.value.contentLF);
        setDirty(false);
        setEditorStats(null);
        setReloadGeneration((g) => g + 1);
        // 外部内容の静かな反映（M7）: 保留中の自動保存タイマーを解除する。
        clearPlainAutosaveTimer();
        reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: false, format: om.format });
        setStatusMessage(`「${om.memoName}」の外部変更を反映しました。`);
      })();
    });

    return () => {
      unsubscribeConflict();
      unsubscribeExternalChange();
    };
  }, [refreshTree, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]);

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
      // 【v3 M9a】ロック解除セッション配下（openMemo.lockToken あり）は M6 個別暗号化とは別物
      // なので、平文と同じ memo:save（lockContext 付き）を使う。
      const res = openMemo.encrypted && !openMemo.lockToken
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
            expectedHash: undefined,
            lockContext: openMemo.lockToken ? { lockToken: openMemo.lockToken } : undefined
          });
      if (res.ok) {
        setOpenMemo(withUpdatedHash(openMemo, res.value.savedHash));
        setDirty(false);
        reportActiveMemo({ tabId: openMemo.tabId, memoName: openMemo.memoName, dirty: false, format: openMemo.format });
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
      // 【v3 M9a】ロック解除セッション配下（openMemo.lockToken あり）は M6 個別暗号化のセッション鍵
      // ではないため crypto:lock は対象外。平文と同じ静かな読み直しで扱う（lockContext 付き）。
      if (openMemo?.encrypted && !openMemo.lockToken) {
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
      const lockToken = openMemo?.tabId === tabId && openMemo.memoName === memoName ? openMemo.lockToken : undefined;
      // v3 M10b: 外部内容の採用でも拡張子（Markdown属性）自体は変わらないため、直前の
      // openMemo.format をそのまま引き継ぐ（docs/v3/milestones/M10b-markdown-live-preview.md §0.7）。
      const format = openMemo?.tabId === tabId && openMemo.memoName === memoName ? openMemo.format : undefined;
      const res = await ipc.readMemo({ tabId, memoName, lockContext: lockToken ? { lockToken } : undefined });
      if (res.ok) {
        setOpenMemo(createOpenMemoState(tabId, memoName, res.value, lockToken, format));
        setContentLF(res.value.contentLF);
        setDirty(false);
        setEditorStats(null);
        setReloadGeneration((g) => g + 1);
        // 外部内容の採用（M7）: 保留中の自動保存は古い本文を前提にしているため破棄する。
        clearPlainAutosaveTimer();
        reportActiveMemo({ tabId, memoName, dirty: false, format });
        setStatusMessage(`「${memoName}」の外部変更を反映しました。`);
      } else {
        // 外部で削除されていた場合など。メモを閉じる。
        clearPlainAutosaveTimer();
        setOpenMemo(null);
        setContentLF('');
        setDirty(false);
        setEditorStats(null);
        reportActiveMemo(null);
        setStatusMessage(`「${memoName}」は外部で削除されました。`);
      }
      setConflictInfo(null);
    })();
  }, [conflictInfo, openMemo, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]);

  const handleToggleTheme = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    void ipc.setSettings({ theme: next }).catch((e: unknown) => console.error('settings:set failed', e));
  }, [theme, setTheme]);

  const handleChangeUiFontScale = useCallback((next: number) => {
    setUiFontScale(next);
    void ipc.setSettings({ uiFontScale: next }).catch((e: unknown) => console.error('settings:set failed', e));
  }, []);

  const handleToggleAlwaysOnTop = useCallback(() => {
    setAlwaysOnTop((prev) => {
      const next = !prev;
      void ipc.setAlwaysOnTop({ enabled: next }).catch((e: unknown) => console.error('window:setAlwaysOnTop failed', e));
      return next;
    });
  }, []);

  const handleChangeOpenAtLogin = useCallback((enabled: boolean) => {
    setOpenAtLogin(enabled);
    void ipc.setOpenAtLogin({ enabled }).catch((e: unknown) => console.error('window:setOpenAtLogin failed', e));
  }, []);

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
    // 【v3 M9c】直前タブに紐づくノードロック解除セッションを一括破棄する（DESIGNv3 §1.11
    // 「タブから離れたら即座にセッション破棄」）。順序厳守: dirty確認→保存/破棄確定（上の
    // requestCloseCurrentMemo）→タブ切替（下の setSelectedTabId 等）→セッション破棄（ここ）。
    // requestCloseCurrentMemo がキャンセルされた場合は上で return 済みのためセッションは
    // 破棄されない。切替先が同一タブの場合（`tabId === selectedTabId`）は「離脱」に該当しない
    // ため破棄しない。同一タブ内の別ノード操作でセッションを継続する既存仕様と整合させるため。
    const prevTabId = selectedTabIdRef.current;
    setSelectedTabId(tabId);
    setSelection(EMPTY_SELECTION);
    setOpenMemo(null);
    setContentLF('');
    setDirty(false);
    setEditorStats(null);
    setRevealTarget(null);
    setConflictInfo(null);
    reportActiveMemo(null);
    if (prevTabId && prevTabId !== tabId) {
      void ipc.relockAllInTab({ tabId: prevTabId }).catch((e: unknown) => console.error('crypto:relockAllInTab failed', e));
    }
    await refreshTree(tabId);
  }, [refreshTree, reportActiveMemo, requestCloseCurrentMemo]);

  const openMemoByName = useCallback(
    async (memoName: string, encrypted: boolean, focusEditor = true, lockToken?: string, formatHint?: 'plain' | 'markdown') => {
      if (!selectedTabId) return;
      if (!(await requestCloseCurrentMemo())) {
        return;
      }
      // 【v3 M9a / M9a-R2-01】ロック解除セッション配下（起点＋子孫）は `TreeNode.lockToken` を
      // 保持する（PLANv3 §1.3）。`memoName` の文字列一致のみでの自己解決（`findTreeNode`）は、
      // 同名ノードが複数スコープに同時存在しうる（PLANv3 §7.3）ため行わない。呼び出し元
      // （Tree.tsx の行クリック/矢印キー移動＝行データそのもの、または作成直後の明示指定）が
      // 対象ノード自身の `lockToken` を hint として渡す前提にする（reviewer指摘 M9a-R2-01）。
      if (encrypted && !lockToken) {
        // 暗号化メモ（ロックセッション配下ではない、M6 個別暗号化）は開封にパスワードが必要
        // （crypto:open）。ロックセッション配下は既にパスワード入力済みで開封済みのため
        // パスワードダイアログを経由しない。
        setCryptoDialog({ mode: 'unlockToOpen', tabId: selectedTabId, memoName });
        setCryptoDialogError(null);
        return;
      }
      const res = await ipc.readMemo({
        tabId: selectedTabId,
        memoName,
        lockContext: lockToken ? { lockToken } : undefined
      });
      if (res.ok) {
        // v3 M10b: 現在のツリー状態（クリックされた行そのものが由来のスナップショット、
        // §0.7「平文メモ、およびロック解除セッション配下メモ」の判定方針）から Markdown 属性を
        // 引く。scope-qualified（同名ノードが複数スコープに同時存在しうるため, PLANv3 §7.3）。
        // 【v3 M10c】`formatHint` 指定時はそちらを優先する。作成直後（handleRequestCreate）は
        // `tree` state の更新が同一イベントハンドラ内でまだコミットされておらず、この時点で
        // `findTreeNodeInScope` を引いても新規ノードが見つからない（stale closure）ため、
        // 呼び出し元が作成時に指定した format をそのまま渡せるようにする。
        const format = formatHint ?? findTreeNodeInScope(tree, memoName, lockToken)?.format;
        setOpenMemo(createOpenMemoState(selectedTabId, memoName, res.value, lockToken, format));
        setContentLF(res.value.contentLF);
        setDirty(false);
        setEditorStats(null);
        setStatusMessage(null);
        // 通常のメモオープンでは前回のジャンプ位置を持ち越さない（handleJumpToHit は本関数の
        // 呼び出し後に必要な場合のみ revealTarget を再設定する）。
        setRevealTarget(null);
        setConflictInfo(null);
        setReloadGeneration(0);
        setEditorAutoFocus(focusEditor);
        reportActiveMemo({ tabId: selectedTabId, memoName, dirty: false, format });
      } else {
        setStatusMessage(`メモ読込エラー: ${res.error.message}`);
      }
    },
    [selectedTabId, tree, reportActiveMemo, requestCloseCurrentMemo]
  );

  // editorAutoFocus は CodeMirrorEditor のマウント時に一度だけ消費される「単発の指示」なので、
  // 反映後（openMemo 変化のたびに実行される本 effect は子のマウント effect より後に走る）は
  // 次回の既定値である true に戻しておく（ツリーの矢印キー連続移動以外の全経路に影響しないため）。
  useEffect(() => {
    setEditorAutoFocus(true);
  }, [openMemo]);

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
      // v3 M10b: 全文検索ヒットはセッション配下を対象外とする既存仕様（DESIGNv3 §1.7 Q1）のため
      // scope-qualified lookup は不要。best-effort（tabId をまたぐ直後のジャンプでは tree が
      // 直前タブのまま一瞬ずれ得るが、装飾描画のみに影響する非致命的な事項, §0.7 developer裁量）。
      const format = findTreeNode(tree, hit.memoName)?.format;
      setOpenMemo(createOpenMemoState(hit.tabId, hit.memoName, res.value, undefined, format));
      setContentLF(res.value.contentLF);
      setDirty(false);
      setEditorStats(null);
      setStatusMessage(null);
      setRevealTarget(null);
      setConflictInfo(null);
      setReloadGeneration(0);
      reportActiveMemo({ tabId: hit.tabId, memoName: hit.memoName, dirty: false, format });
      if (hit.matchField === 'body' && hit.matchStart !== undefined && hit.matchEnd !== undefined) {
        revealTokenRef.current += 1;
        setRevealTarget({ from: hit.matchStart, to: hit.matchEnd, token: revealTokenRef.current });
      }
    },
    [selectTab, tree, reportActiveMemo, requestCloseCurrentMemo]
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
      // v3 M10b: `memo:` リンク遷移も handleJumpToHit と同じ best-effort（§0.7 developer裁量）。
      const format = findTreeNode(tree, memoName)?.format;
      setOpenMemo(createOpenMemoState(tabId, memoName, res.value, undefined, format));
      setContentLF(res.value.contentLF);
      setDirty(false);
      setEditorStats(null);
      setStatusMessage(null);
      setRevealTarget(null);
      setConflictInfo(null);
      setReloadGeneration(0);
      // 左ペインの選択も合わせる（ユーザー要望: 起動時復元/memo:リンク遷移でもツリー側の
      // ハイライト・スクロール位置が追従するように。スクロール自体は Tree.tsx が
      // openMemoName の変化を見て行う）。
      setSelection(selectSingle(memoName));
      reportActiveMemo({ tabId, memoName, dirty: false, format });
    },
    [tree, reportActiveMemo]
  );

  // 起動時に前回開いていたメモを復元する（ユーザー要望）。タブ/メモが削除済み等で復元できない
  // 場合はエラー表示せず黙って何もしない。暗号化メモの場合は openMemoDirect が自動でパスワード
  // 入力ダイアログを開く（memo: リンク遷移と同じ挙動、developer 判断）。
  useEffect(() => {
    void (async () => {
      const settingsRes = await ipc.getSettings();
      if (!settingsRes.ok || !settingsRes.value.lastOpened) return;
      const { tabId, memoName } = settingsRes.value.lastOpened;
      const tabsRes = await ipc.listTabs();
      if (!tabsRes.ok || !tabsRes.value.some((t) => t.id === tabId)) return;
      await selectTab(tabId);
      if (selectedTabIdRef.current !== tabId) return;
      await openMemoDirect(tabId, memoName);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        reportActiveMemo({ tabId: om.tabId, memoName: om.memoName, dirty: true, format: om.format });
        // 【v3 M9a】ロック解除セッション配下（om.lockToken あり）は M6 個別暗号化の低頻度自動保存
        // ではなく、平文と同じ自動保存（lockContext 付き memo:save）を使う。
        if (om.encrypted && !om.lockToken) {
          // 暗号化メモの低頻度自動保存（DESIGN §2.6「編集停止から一定時間のデバウンス」, M6）。
          scheduleEncryptedAutosave();
        } else {
          // 平文メモの自動保存（M7, DESIGN §2.6「適度な自動保存」）。
          schedulePlainAutosave();
        }
      }
    },
    [reportActiveMemo, scheduleEncryptedAutosave, schedulePlainAutosave]
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
    // 【v3 M9a】ロック解除セッション配下（openMemo.lockToken あり）は M6 個別暗号化とは別物なので、
    // 平文と同じ memo:save（lockContext 付き）を使う。
    const res = openMemo.encrypted && !openMemo.lockToken
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
          expectedHash: openMemo.lastKnownHash,
          lockContext: openMemo.lockToken ? { lockToken: openMemo.lockToken } : undefined
        });
    if (res.ok) {
      setOpenMemo(withUpdatedHash(openMemo, res.value.savedHash));
      setDirty(false);
      reportActiveMemo({ tabId: openMemo.tabId, memoName: openMemo.memoName, dirty: false, format: openMemo.format });
      setStatusMessage(`保存しました（${openMemo.memoName}）`);
    } else {
      setStatusMessage(`保存エラー[${res.error.code}]: ${res.error.message}`);
    }
  }, [openMemo, contentLF, dirty, conflictInfo, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]);

  // v3 M10c: 画像貼り付け/ドロップがサイズ警告閾値を超えた場合（CodeMirrorEditor.tsx →
  // editor/imagePaste.ts から委譲される）。実際に検出したサイズ（約◯MB）を明記した確認ダイアログを
  // 表示し（DESIGNv3 §2.6「警告メッセージには実際に検出した画像サイズを明記する」）、続行時のみ
  // `request.insert()` を呼ぶ（既存の `ConfirmDialog` を流用、閾値以下の場合はこのコールバック自体
  // 呼ばれず直接挿入される）。
  const handleImagePasteRequest = useCallback((request: PendingImageInsert) => {
    const mb = (request.sizeBytes / (1024 * 1024)).toFixed(1);
    setConfirmDialog({
      title: '画像を挿入',
      message: `この画像は約${mb}MBです。挿入すると動作が重くなる可能性があります。挿入しますか？`,
      confirmLabel: '挿入',
      onConfirm: () => {
        setConfirmDialog(null);
        request.insert();
      }
    });
  }, []);

  // 【v3 M10c, reviewer指摘 M10c-R1-01 対応】貼り付け/ドロップされた画像がサニタイズ許可リスト外
  // の形式（bmp/svg等）だった場合、挿入自体を行わず（imagePaste.ts側で既に判定済み）ユーザーへ
  // 理由を明示する。
  const handleUnsupportedImagePaste = useCallback(() => {
    setStatusMessage('この画像形式はサポートされていません（対応形式: png, jpg, jpeg, gif, webp）。');
  }, []);

  // v3 M10c: `.txt`⇔`.md`変換（DESIGNv3 §2.4、docs/v3/milestones/M10c-markdown-toolbar-ui.md）。
  // `.md`→`.txt`のみ、本文中の装飾タグ(`<span`)/画像データURI(`data:image/`)の有無を正規表現で
  // 検出し、検出時のみ確認ダイアログを表示する（DESIGNv3 §2.4「検出しなかった場合は無警告で
  // 変換してよい」）。`.txt`→`.md`は本文へ手を加える必要が無いため無警告。
  const handleConvertFormat = useCallback(
    (targetFormat: 'txt' | 'md') => {
      if (!openMemo || !selectedTabId) return;
      // ボタン自体を非表示にする想定だが、防御的に対象外ケースを弾く（M10a: 暗号化メモ・ノード
      // ロックセッション配下メモは memo:convertFormat の対象外）。
      if (openMemo.encrypted || openMemo.lockToken) return;
      const tabId = selectedTabId;
      const memoName = openMemo.memoName;
      const doConvert = async (): Promise<void> => {
        const res = await ipc.convertMemoFormat({ tabId, memoName, targetFormat });
        if (res.ok) {
          const newFormat: 'plain' | 'markdown' = targetFormat === 'md' ? 'markdown' : 'plain';
          setOpenMemo((prev) => (prev && prev.tabId === tabId && prev.memoName === memoName ? { ...prev, format: newFormat } : prev));
          // Compartment 経由のプレビュー描画は `markdown` prop の値（マウント時固定）に依存するため、
          // format が変わった場合は再マウントして反映させる（既存の外部反映と同じ reloadGeneration
          // パターン。本文=contentLF 自体は変換で変化しないためそのまま引き継がれる）。previewMode は
          // 上の reloadGeneration 変化を見ている effect が既定値=true へ自動的にリセットする。
          setReloadGeneration((g) => g + 1);
          void refreshTree(tabId);
          reportActiveMemo({ tabId, memoName, dirty: dirtyRef.current, format: newFormat });
          setStatusMessage(targetFormat === 'md' ? 'Markdown形式（.md）に変換しました。' : '通常のテキスト形式（.txt）に変換しました。');
        } else {
          setStatusMessage(`変換エラー[${res.error.code}]: ${res.error.message}`);
        }
      };
      if (targetFormat === 'txt') {
        const hasDecorationOrImage = /<span[\s>]/i.test(contentLF) || /data:image\//i.test(contentLF);
        if (hasDecorationOrImage) {
          setConfirmDialog({
            title: '.txtへ変換',
            message: 'この操作を行うと、色などの装飾用タグや画像データがそのまま文字として表示されるようになります。続行しますか？',
            confirmLabel: '続行',
            danger: true,
            onConfirm: () => {
              setConfirmDialog(null);
              void doConvert();
            }
          });
          return;
        }
      }
      void doConvert();
    },
    [openMemo, selectedTabId, contentLF, refreshTree, reportActiveMemo]
  );

  // 「ロック」ボタン（暗号化メモを開封中のみ表示）: dirty なら自動保存してからセッション鍵を破棄し、
  // レンダラ側の CodeMirror ドキュメント/Undo 履歴も破棄する（厳格な履歴破棄, DESIGN §2.9）。
  const handleLockMemo = useCallback(async () => {
    // 【v3 M9a】ロック解除セッション配下（openMemo.lockToken あり）はこの「ロック」ボタン
    // （M6 個別暗号化の crypto:lock）の対象外。セッション自体はツリー側の「ロックを解除」操作
    // 起点でのみ破棄される（自動再ロックはしない, DESIGNv3 §1.11）。
    if (!openMemo || !openMemo.encrypted || openMemo.lockToken) return;
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

  // --- v3 M8: ノードロック（DESIGNv3 §1、docs/v3/milestones/M8-node-lock-core.md） ---
  // 既存M6の暗号化ダイアログ導線をそのまま流用する（DESIGNv3 §1.11）。dirty ガードは対象外
  // （ロック対象は選択中のノード自体であり、現在開いているメモとは独立した操作のため）。
  const handleRequestLockNode = useCallback(
    (memoName: string) => {
      if (!selectedTabId) return;
      // 開いている(現在表示中の)メモがロック対象配下に含まれる場合は先に閉じてもらう
      // （ロック実行で実ファイルが難読化名へリネーム+暗号化されるため, developer 判断）。
      if (openMemo && openMemo.tabId === selectedTabId && treeNodeContains(tree, memoName, openMemo.memoName)) {
        setStatusMessage('ロック対象のメモが開いています。先に閉じて（別のメモを開くかタブを切り替えて）からロックしてください。');
        return;
      }
      setCryptoDialog({ mode: 'lockNode', tabId: selectedTabId, memoName });
      setCryptoDialogError(null);
    },
    [selectedTabId, openMemo, tree]
  );

  const handleRequestUnlockNode = useCallback(
    (memoName: string) => {
      if (!selectedTabId) return;
      setCryptoDialog({ mode: 'unlockNode', tabId: selectedTabId, memoName });
      setCryptoDialogError(null);
    },
    [selectedTabId]
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
        setOpenMemo(null);
        setContentLF('');
        setDirty(false);
        setEditorStats(null);
        setConflictInfo(null);
        reportActiveMemo(null);
        return;
      }
      if (newEncrypted) {
        // 暗号化された。保留中の平文自動保存タイマーは実行時ガード（om.encrypted チェック）で
        // 安全に無視されるが、明示的に解除しておく（M7, developer 判断）。
        clearPlainAutosaveTimer();
        setOpenMemo((prev) => (prev ? { ...prev, encrypted: true, lastKnownHash: res.value.hash } : prev));
      } else {
        // 暗号化解除（平文へ復帰）。v3 M10b: 拡張子変換自体は起きない（DESIGNv3 §2.5「単なる
        // テキストなので無改造で乗る」）ため、直前の openMemo.format（crypto:open 由来の値）を
        // そのまま引き継ぐ（docs/v3/milestones/M10b-markdown-live-preview.md §0.7）。
        setOpenMemo(createOpenMemoState(tabId, memoName, res.value, undefined, openMemo.format));
        setContentLF(res.value.contentLF);
      }
    },
    [openMemo, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]
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
            // v3 M10b: M6個別暗号化を crypto:open で開封した場合、TreeNode.format は当該ノードが
            // encrypted:true の間 undefined のままのため、CryptoOpenResult.format をローカル状態
            // として保持する（§0.1/§0.7、docs/v3/milestones/M10b-markdown-live-preview.md）。
            setOpenMemo({
              tabId,
              memoName,
              eol: res.value.eol,
              encoding: 'utf-8',
              lastKnownHash: res.value.hash,
              encrypted: true,
              format: res.value.format
            });
            setContentLF(res.value.contentLF);
            setDirty(false);
            setEditorStats(null);
            setStatusMessage(null);
            setRevealTarget(null);
            setConflictInfo(null);
            setReloadGeneration((g) => g + 1);
            reportActiveMemo({ tabId, memoName, dirty: false, format: res.value.format });
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
        if (mode === 'lockNode') {
          // v3 M8: サブツリーをロックする（起点=memoName の配下全体, DESIGNv3 §1）。
          const res = await ipc.lockNode({ tabId, memoName, password: values.password ?? '', hint: values.hint });
          if (res.ok) {
            setCryptoDialog(null);
            setStatusMessage('サブツリーをロックしました。');
            await refreshTree(tabId);
          } else {
            setCryptoDialogError(res.error.message);
          }
          return;
        }
        if (mode === 'unlockNode') {
          // v3 M8: ロック中サブツリーを復号しセッション開始する（`memoName` は難読化トークン）。
          // 返却された `tree`（起点ノード自身を含む単一要素配列）で、ローカルツリー状態上の
          // 🔒 プレースホルダをそのまま丸ごと差し替えて表示する（本マイルストーンのゴール:
          // 「解除直後に返る TreeNode[] が正しく表示される」まで。配下の読み書き等セッション運用は
          // M9 スコープ）。
          const res = await ipc.unlockNode({ tabId, memoName, password: values.password ?? '' });
          if (res.ok) {
            setCryptoDialog(null);
            setCryptoDialogError(null);
            const revealed = res.value.tree[0];
            if (revealed) {
              setTree((prev) => updateTreeNode(prev, memoName, () => revealed));
            }
            setStatusMessage('ロックを解除しました。');
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

  /**
   * `nextTree`（ローカルで既に反映済みの新しいツリー state）を永続化する。`lockTokenHint`
   * は今回の変更の対象ノード自身が保持する `lockToken`（呼び出し元＝Tree.tsx の行データが
   * 把握している値をそのまま渡す, M9a-R2-01）で、これが truthy な場合（v3 M9a のロック解除
   * セッション配下）は、タブ直下の可視ツリー全体ではなくそのセッション自身に `lockContext`
   * 付きで送る（PLANv3 §1.3/§5.3）。セッション配下の変更をタブ直下の通常呼び出しに混ぜて送ると、
   * メイン側 `tree:updateStructure`（lockContext 省略時）はセッション実体をディスクの
   * プレースホルダへ差し戻すだけで反映しない（M8/M9a既存実装、AGENT_LOG「sessionsByRealName」
   * 参照）ため、都度この専用呼び出しが必要。
   * 【M9a-R2-01】以前は対象ノードを `memoName` 文字列一致（`resolveLockContext`）で自己解決して
   * いたが、ロック解除セッション配下はセッション単位でのみ一意（PLANv3 §7.3）のため、タブ直下・
   * 他セッションに同名ノードが同時存在すると誤ったスコープを解決しかねなかった（reviewer指摘）。
   * 呼び出し元が hint を明示することでこの取り違えを解消する。
   */
  const persistTreeStructure = useCallback(
    async (nextTree: TreeNode[], lockTokenHint: string | undefined) => {
      if (!selectedTabId) return;
      setTree(nextTree);
      if (lockTokenHint) {
        const lockContext: LockContext = { lockToken: lockTokenHint };
        const root = findSessionRootNode(nextTree, lockTokenHint);
        if (root) {
          const res = await ipc.updateTreeStructure({
            tabId: selectedTabId,
            lockContext,
            treeStructure: toMetaTree(root.children)
          });
          if (!res.ok) {
            setStatusMessage(`ツリー更新エラー[${res.error.code}]: ${res.error.message}`);
            if (res.error.code === 'LOCK_SESSION_NOT_FOUND') {
              setTree((prev) => collapseSessionToPlaceholder(prev, lockTokenHint));
            }
          }
          return;
        }
      }
      const res = await ipc.updateTreeStructure({ tabId: selectedTabId, treeStructure: toMetaTree(nextTree) });
      if (!res.ok) {
        setStatusMessage(`ツリー更新エラー[${res.error.code}]: ${res.error.message}`);
        await refreshTree(selectedTabId);
      }
    },
    [selectedTabId, refreshTree]
  );

  const handleToggleExpand = useCallback(
    (memoName: string, lockToken?: string) => {
      void persistTreeStructure(
        updateTreeNodeInScope(tree, memoName, lockToken, (n) => ({ ...n, expanded: !n.expanded })),
        lockToken
      );
    },
    [tree, persistTreeStructure]
  );

  const handleRequestSetLabel = useCallback(
    (memoName: string, color: string | null, lockToken?: string) => {
      void persistTreeStructure(
        updateTreeNodeInScope(tree, memoName, lockToken, (n) => ({ ...n, label: { color, kind: n.label?.kind ?? null } })),
        lockToken
      );
    },
    [tree, persistTreeStructure]
  );

  // 編集ロック切替（本文編集のみ禁止。リネーム/削除等ファイル操作は対象外, ユーザー要望）。
  const handleRequestToggleLock = useCallback(
    (memoName: string, lockToken?: string) => {
      void persistTreeStructure(
        updateTreeNodeInScope(tree, memoName, lockToken, (n) => ({ ...n, locked: !n.locked })),
        lockToken
      );
    },
    [tree, persistTreeStructure]
  );

  // プロパティ画面（ユーザー要望）。ツリー右クリック（selectedTabId 前提）とエディタのネイティブ
  // 右クリックメニュー（evt:showProperties、main 側が把握する現在アクティブなタブ指定）の
  // 両方から呼ばれる共通処理。
  const showPropertiesFor = useCallback(async (tabId: string, memoName: string) => {
    const res = await ipc.getMemoProperties({ tabId, memoName });
    if (res.ok) {
      setPropertiesDialog({ tabId, properties: res.value });
    } else {
      setStatusMessage(`プロパティ取得エラー[${res.error.code}]: ${res.error.message}`);
    }
  }, []);

  const handleRequestProperties = useCallback(
    (memoName: string) => {
      if (!selectedTabId) return;
      void showPropertiesFor(selectedTabId, memoName);
    },
    [selectedTabId, showPropertiesFor]
  );

  useEffect(() => {
    return ipc.onShowProperties((payload: ShowPropertiesPayload) => {
      void showPropertiesFor(payload.tabId, payload.memoName);
    });
  }, [showPropertiesFor]);

  // --- 同一タブ内 DND（並べ替え・階層変更はメタのみ、コピーは memo:move） ---

  const handleLocalMove = useCallback(
    async (
      draggedNames: string[],
      destAnchorMemoName: string,
      zone: DropZone,
      anchorLockToken?: string,
      srcLockToken?: string
    ) => {
      if (!selectedTabId) return;

      // 【v3 M9b・最重要】「一方通行の金庫」（DESIGNv3 §1.12）。ドラッグ元行自身の lockToken
      // （srcLockToken、掴んだ行そのものの hint）が truthy で、かつドロップ先（anchorLockToken）
      // と一致しない場合（内→外、または別ロック間）は拒否する。Tree.tsx の TreeRow（canAcceptDrop）
      // /Tree.tsx（handleRowDrop）が既に事前ブロックしているはずだが、ここでも同一ルールを
      // 再検証する（多層防御。IPC側 memoHandlers.ts の handleLockBoundaryMove が最終防衛線）。
      if (srcLockToken && srcLockToken !== anchorLockToken) {
        setStatusMessage('ロック解除中の場所から、外部または別のロックへは移動できません（一方通行の金庫）。');
        return;
      }

      // 【v3 M9b】通常領域 → ロック解除セッション配下（「外→内」、許可、PLANv3 §5.4）。実ファイルの
      // 暗号化変換（難読化名へのリネーム+暗号化, dest側nameMap/children/claimedTokensへの組込み）を
      // 伴うため、既存の M9a セッション内 tree:updateStructure 専用経路では対応できず、
      // memo:move（destLockContext 付き）へ委譲する。
      if (anchorLockToken && !srcLockToken) {
        const res = await ipc.moveMemo({
          srcTabId: selectedTabId,
          memoNames: draggedNames,
          destTabId: selectedTabId,
          destPosition: dropZoneToPosition(zone),
          destAnchorMemoName,
          copy: false,
          destLockContext: { lockToken: anchorLockToken }
        });
        if (res.ok) {
          // dest（セッション）側・src（タブ直下）側の両方が変わるため、tab:openTree を再取得する
          // （既存セッションは reconcile が tabId 経由で展開表示を維持するため巻き戻らない, M8）。
          await refreshTree(selectedTabId);
        } else {
          setStatusMessage(`移動エラー[${res.error.code}]: ${res.error.message}`);
        }
        return;
      }

      // 【v3 M9a / M9a-R2-01】ドロップ先アンカー行そのものが保持する lockToken（Tree.tsx の
      // 行データから得た hint。ユーザーが実際にドロップした行そのものなので取り違えようがない）
      // が truthy な場合（この時点で srcLockToken===anchorLockToken、つまり同一セッション内の
      // 並べ替え。境界を跨がない, PLANv3 §5.4 表の最終行）、タブ直下の可視ツリー全体ではなく
      // そのセッション自身へ lockContext 付きで送る（PLANv3 §1.3/§5.3）。以前はドラッグ対象+
      // アンカー全ての `memoName` を `findTreeNode`（文字列一致のみ）で解決し、得られた
      // lockToken 集合が単一かどうかで判定していたが、同名ノードが複数スコープに同時存在する
      // 場合（PLANv3 §7.3）に誤ったスコープを解決しかねなかった（reviewer指摘 M9a-R2-01）。
      // アンカーの hint を正として、ドラッグ対象各々は `findTreeNodeInScope` でこのスコープに
      // 実在するものだけを対象にする（見つからないドラッグ対象＝別スコープの同名ノードを誤って
      // 掴むよりは、移動せずスキップする方が安全）。
      if (anchorLockToken) {
        const root = findSessionRootNode(tree, anchorLockToken);
        if (root) {
          const metaChildren = toMetaTree(root.children);
          for (const name of draggedNames) {
            if (name === destAnchorMemoName || isDescendantOf(metaChildren, name, destAnchorMemoName)) {
              setStatusMessage('選択したメモ自身またはその子孫へは移動できません。');
              return;
            }
          }
          let children: readonly TreeNode[] = root.children;
          const movedNodes: TreeNode[] = [];
          for (const name of draggedNames) {
            const found = findTreeNodeInScope(children, name, anchorLockToken);
            if (found) {
              movedNodes.push(found);
              children = removeTreeNodesByNamesInScope(children, new Set([name]), anchorLockToken);
            }
          }
          const position = dropZoneToPosition(zone);
          for (const node of orderForBatchInsert(movedNodes, position)) {
            children = insertTreeNodeAtInScope(children, node, position, anchorLockToken, destAnchorMemoName);
          }
          const lockContext: LockContext = { lockToken: anchorLockToken };
          const res = await ipc.updateTreeStructure({
            tabId: selectedTabId,
            lockContext,
            treeStructure: toMetaTree(children)
          });
          if (res.ok) {
            const finalChildren = children;
            setTree((prev) => updateTreeNodeInScope(prev, root.memoName, root.lockToken, (n) => ({ ...n, children: finalChildren })));
          } else {
            setStatusMessage(`移動エラー[${res.error.code}]: ${res.error.message}`);
            if (res.error.code === 'LOCK_SESSION_NOT_FOUND') {
              setTree((prev) => collapseSessionToPlaceholder(prev, anchorLockToken));
            }
          }
          return;
        }
      }

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
    async (
      draggedNames: string[],
      destAnchorMemoName: string,
      zone: DropZone,
      anchorLockToken?: string,
      srcLockToken?: string
    ) => {
      if (!selectedTabId) return;

      // 【v3 M9b】「一方通行の金庫」（DESIGNv3 §1.12）。handleLocalMove と同じ判定
      // （Tree.tsx の事前ブロックに続く多層防御。IPC側 handleLockBoundaryMove が最終防衛線）。
      if (srcLockToken && srcLockToken !== anchorLockToken) {
        setStatusMessage('ロック解除中の場所から、外部または別のロックへはコピーできません（一方通行の金庫）。');
        return;
      }

      // srcLockToken===anchorLockToken（両方 undefined=通常領域どうし、または同一セッション内）
      // ならそのまま lockContext を組み立てて memo:move へ渡す。「外→内」（srcLockToken 無し・
      // anchorLockToken 有り）も同じ呼び出しで扱える（destLockContext のみ付与, PLANv3 §5.4）。
      const srcLockContext: LockContext | undefined = srcLockToken ? { lockToken: srcLockToken } : undefined;
      const destLockContext: LockContext | undefined = anchorLockToken ? { lockToken: anchorLockToken } : undefined;

      const res = await ipc.moveMemo({
        srcTabId: selectedTabId,
        memoNames: draggedNames,
        destTabId: selectedTabId,
        destPosition: dropZoneToPosition(zone),
        destAnchorMemoName,
        copy: true,
        srcLockContext,
        destLockContext
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
      // 【v3 M9b】「一方通行の金庫」（DESIGNv3 §1.12）。TabBar へのドロップ先は常にタブ直下
      // （`destPosition:'last'`、セッション配下を指定する手段がUI上存在しない=常に「通常領域」）
      // のため、ドラッグ元がロック解除セッション配下（`payload.srcLockToken` truthy）の場合は
      // 内→外の移動・コピーになり常に禁止（レンダラの事前拒否。IPC側 memoHandlers.ts の
      // handleLockBoundaryMove でも同一ルールを再検証する二重防御）。
      // 【reviewer指摘 M9b-R1-01】上記の `srcLockToken` はドラッグ元が「ロック解除セッション配下」
      // であることしか示さない。ドラッグ元行自身が `nodeLocked`（未解除の🔒プレースホルダ、
      // トップレベル/入れ子いずれも）の場合は `srcLockToken` が無い（もともと通常領域のスコープ）
      // ため上のガードを素通りしてしまい、ロック中の中身をパスワード無しでタブ間へ物理移動できて
      // しまう穴があった。`srcNodeLocked`（掴んだ行自身の nodeLocked フラグ）で別途拒否する
      // （IPC側 memoHandlers.ts の plain v1 memo:move 経路でも `.lock` 保有ノードのタブ間移動を
      // 再検証・拒否する二重防御を追加済み）。
      if (payload.srcLockToken || payload.srcNodeLocked) {
        setStatusMessage('ロック中のノードは別のタブへ移動・コピーできません（一方通行の金庫）。');
        return;
      }
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
    (position: AddPosition, anchorMemoName?: string, anchorLockToken?: string, format?: 'plain' | 'markdown') => {
      if (!selectedTabId) return;
      const name = generateDefaultMemoName(collectTreeNames(toMetaTree(tree)));
      // 【v3 M9a / M9a-R2-01】anchorLockToken は Tree.tsx の行データ（右クリックされたアンカー行
      // そのもの）から得た hint。以前は `resolveLockContext`（`anchorMemoName` の文字列一致のみ）
      // で自己解決していたが、同名ノードが複数スコープに同時存在する場合（PLANv3 §7.3）に誤った
      // スコープを解決しかねなかった（reviewer指摘）。hint をそのまま使うことで解決する。
      const lockContext: LockContext | undefined = anchorMemoName && anchorLockToken ? { lockToken: anchorLockToken } : undefined;
      // v3 M10c: 新規メモ作成時の「通常メモ」「Markdownメモ」選択（DESIGNv3 §2.4）。未指定時は
      // 既存動作通り 'plain'（.txt）。
      const effectiveFormat: 'plain' | 'markdown' = format ?? 'plain';
      void (async () => {
        const res = await ipc.createMemo({ tabId: selectedTabId, name, position, anchorMemoName, format, lockContext });
        if (res.ok) {
          setStatusMessage(`メモを作成しました: ${res.value.memoName}`);
          if (lockContext) {
            // セッション配下: `tab:openTree` はセッションを認識しないため、refreshTree を挟まず
            // ローカルで直接反映する（挟むと表示上セッションが閉じてしまう）。
            const newNode: TreeNode = {
              memoName: res.value.memoName,
              encrypted: res.value.encrypted,
              expanded: true,
              children: [],
              lockToken: lockContext.lockToken,
              format: effectiveFormat
            };
            setTree((prev) => insertTreeNodeAtInScope(prev, newNode, position, lockContext.lockToken, anchorMemoName));
          } else {
            await refreshTree(selectedTabId);
          }
          setSelection(selectSingle(res.value.memoName));
          // 【v3 M10c】`formatHint` を明示的に渡す: 直上の `setTree`/`refreshTree` は React の
          // 状態更新が非同期のため、この時点で `openMemoByName` 内部の `tree` はまだ更新前の
          // スナップショットを参照する（stale closure）。作成時に確定している `effectiveFormat` を
          // そのまま渡すことで、作成直後からライブプレビューが正しく有効になるようにする。
          await openMemoByName(res.value.memoName, res.value.encrypted, true, lockContext?.lockToken, effectiveFormat);
        } else {
          setStatusMessage(`メモ作成エラー[${res.error.code}]: ${res.error.message}`);
          if (lockContext && res.error.code === 'LOCK_SESSION_NOT_FOUND') {
            setTree((prev) => collapseSessionToPlaceholder(prev, lockContext.lockToken));
          }
        }
      })();
    },
    [selectedTabId, tree, refreshTree, openMemoByName]
  );

  const handleRequestRename = useCallback(
    (oldName: string, lockToken?: string) => {
      if (!selectedTabId) return;
      // 【v3 M9a / M9a-R2-01】lockToken は Tree.tsx の行データ（右クリックされた行そのもの）から
      // 得た hint。以前は `resolveLockContext`（`oldName` の文字列一致のみ）で自己解決していたが、
      // 同名ノードが複数スコープに同時存在する場合（PLANv3 §7.3）に誤ったスコープを解決しかねな
      // かった（reviewer指摘）。hint をそのまま使うことで解決する。
      const lockContext: LockContext | undefined = lockToken ? { lockToken } : undefined;
      setNameDialog({
        title: 'メモ名を変更',
        label: '新しいメモ名',
        initialValue: oldName,
        submitLabel: '変更',
        onSubmit: (newName) => {
          setNameDialog(null);
          if (newName === oldName) return;
          void (async () => {
            const res = await ipc.renameMemo({ tabId: selectedTabId, oldName, newName, lockContext });
            if (res.ok) {
              setStatusMessage(`リネームしました: ${oldName} → ${newName}`);
              // openMemo.lockToken も一致することを確認し、別スコープの同名メモを誤って
              // 「現在開いているメモ」として書き換えないようにする（M9a-R2-01）。
              if (openMemo?.tabId === selectedTabId && openMemo.memoName === oldName && openMemo.lockToken === lockToken) {
                setOpenMemo({ ...openMemo, memoName: newName });
                reportActiveMemo({ tabId: selectedTabId, memoName: newName, dirty: dirtyRef.current, format: openMemo.format });
              }
              if (lockContext) {
                // セッション配下: refreshTree を挟まずローカルで直接反映する（理由は create 参照）。
                setTree((prev) => updateTreeNodeInScope(prev, oldName, lockToken, (n) => ({ ...n, memoName: newName })));
              } else {
                await refreshTree(selectedTabId);
              }
            } else {
              setStatusMessage(`リネームエラー[${res.error.code}]: ${res.error.message}`);
              if (lockContext && res.error.code === 'LOCK_SESSION_NOT_FOUND') {
                setTree((prev) => collapseSessionToPlaceholder(prev, lockContext.lockToken));
              }
            }
          })();
        }
      });
    },
    [selectedTabId, openMemo, refreshTree, reportActiveMemo]
  );

  const handleRequestDelete = useCallback(
    (memoNames: string[], lockToken?: string) => {
      if (!selectedTabId || memoNames.length === 0) return;
      // 【v3 M9a-R2-01/R2-02】lockToken は Tree.tsx の行データ（右クリックされた行そのもの）から
      // 得た hint。以前は `resolveLockContext(tree, memoNames[0])` で「先頭の対象」の文字列一致
      // のみから自己解決していたため、(a) 同名ノードが複数スコープに同時存在する場合
      // （PLANv3 §7.3）に誤ったスコープを解決しかねず（M9a-R2-01）、(b) バッチ内の対象が
      // 一部だけ異なるスコープに属する（ロック解除中セッション内とタブ直下にまたがる）ケースの
      // 均質性を検証していなかった（M9a-R2-02）。
      // メイン側 deleteMemosInSession/memo:delete は対象外の名前を「拒否」ではなく「既に削除済み
      // として成功扱い(no-op)」する実装のため、スコープ混在バッチを片方のスコープだけへ送ると、
      // もう片方は実際には削除されないまま ok が返り、ローカルの removeTreeNodesByNamesInScope が
      // 見た目上ツリーから消してしまう（実ファイルは無傷なのに UI 上「削除できた」ように誤表示
      // され続ける）。そのため、`memoNames` 全体が hint と同一スコープ（scope-qualified lookup で
      // 発見できる）かどうかを事前に検証し、1件でも属さなければ操作を中断する（reviewer指摘）。
      const homogeneous = memoNames.every((n) => !!findTreeNodeInScope(tree, n, lockToken));
      if (!homogeneous) {
        setStatusMessage(
          'ロック解除中セッション内とタブ直下など、異なる場所にまたがる削除は一度に行えません。同じ場所のメモだけを選択し直してください。'
        );
        return;
      }
      const lockContext: LockContext | undefined = lockToken ? { lockToken } : undefined;
      setConfirmDialog({
        title: 'メモを削除',
        message: `以下 ${memoNames.length} 件のメモをごみ箱へ送ります。よろしいですか？\n${memoNames.join(', ')}`,
        confirmLabel: '削除',
        danger: true,
        onConfirm: () => {
          setConfirmDialog(null);
          void (async () => {
            const res = await ipc.deleteMemo({ tabId: selectedTabId, memoNames, lockContext });
            const closeIfOpen = (): void => {
              // openMemo.lockToken も一致することを確認し、別スコープの同名メモを誤って閉じない
              // ようにする（M9a-R2-01）。
              if (openMemo && memoNames.includes(openMemo.memoName) && openMemo.lockToken === lockToken) {
                clearEncryptedAutosaveTimer();
                clearPlainAutosaveTimer();
                setOpenMemo(null);
                setContentLF('');
                setDirty(false);
                setEditorStats(null);
                setConflictInfo(null);
                reportActiveMemo(null);
              }
            };
            if (lockContext) {
              // 【v3 M9a】セッション配下: refreshTree を挟まずローカルで直接反映する（理由は
              // create 参照）。evt:trashFallback 導線もセッション配下は配線されていない
              // （developer報告済みスコープ外事項）ため、TRASH_FAILED も含め通常のエラーとして扱う。
              if (res.ok) {
                setStatusMessage('削除しました。');
                closeIfOpen();
                setSelection(EMPTY_SELECTION);
                setTree((prev) => removeTreeNodesByNamesInScope(prev, new Set(memoNames), lockToken));
              } else {
                setStatusMessage(`削除エラー[${res.error.code}]: ${res.error.message}`);
                if (res.error.code === 'LOCK_SESSION_NOT_FOUND') {
                  setTree((prev) => collapseSessionToPlaceholder(prev, lockContext.lockToken));
                }
              }
              return;
            }
            if (res.ok) {
              setStatusMessage('削除しました。');
              closeIfOpen();
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
    [selectedTabId, tree, openMemo, refreshTree, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]
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
  }, [trashFallback, selectedTabId, openMemo, refreshTree, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]);

  // --- タブ操作（PLAN §2.1） ---

  const handleRequestRegisterTab = useCallback(() => {
    void (async () => {
      const picked = await ipc.pickFolder();
      if (!picked.ok || !picked.value) return;
      const res = await ipc.registerTab({ folderPath: picked.value });
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
    setNameDialog({
      title: '新規タブ作成',
      label: 'タブ（フォルダ）名',
      submitLabel: '作成',
      onSubmit: (name) => {
        setNameDialog(null);
        void (async () => {
          // parentDir 省略時はアプリ本体直下の data フォルダに作成される（ポータブル性優先）。
          const res = await ipc.createTab({ name });
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
    [tabs, selectedTabId, refreshTabs, reportActiveMemo, clearEncryptedAutosaveTimer, clearPlainAutosaveTimer]
  );

  const handleRequestOpenTabFolder = useCallback((tabId: string) => {
    void (async () => {
      const res = await ipc.openTabFolder({ tabId });
      if (!res.ok) setStatusMessage(`フォルダを開けませんでした[${res.error.code}]: ${res.error.message}`);
    })();
  }, []);

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
  // フォントサイズ変更（clamp + settings:set 永続化のデバウンス）。Ctrl+ホイールと、エディタ
  // 右クリックメニュー「書式」のフォントサイズ拡大/縮小/リセット（ユーザー要望）の両方から使う。
  const applyFontSizeChange = useCallback((compute: (prev: number) => number) => {
    setEditorSettings((prev) => {
      const next = clampFontSize(compute(prev.fontSize));
      if (next === prev.fontSize) return prev;
      if (fontSizePersistTimer.current) clearTimeout(fontSizePersistTimer.current);
      fontSizePersistTimer.current = setTimeout(() => {
        void ipc
          .setSettings({ editorDefaults: { fontSize: next } })
          .catch((err: unknown) => console.error('settings:set (fontSize) failed', err));
      }, FONT_SIZE_PERSIST_DEBOUNCE_MS);
      return { ...prev, fontSize: next };
    });
  }, []);

  // 【post-M10 bugfix】MarkdownToolbar の装飾ボタン（文字色/太字/文字サイズ）。右クリックメニュー
  // 経由のIPC（`kind: 'decoration'`, 廃止済み）と異なり、同一プロセス内なので editorRef を
  // 直接呼ぶだけでよい。
  const handleDecorate = useCallback((command: MarkdownDecorationCommand) => {
    editorRef.current?.runDecorationCommand(command);
  }, []);

  // エディタ右クリックメニューの各種コマンド（ユーザー要望）。CodeMirror 内部状態を直接触る
  // ものは editorRef 経由（textCommand）、それ以外は既存の設定変更ハンドラへ委譲する。
  // 【post-M10 bugfix】装飾コマンド（文字色/太字/文字サイズ）は右クリックメニューから
  // MarkdownToolbar のボタンへ移設したため、`kind: 'decoration'` はこのIPC経路には来なくなった
  // （`handleDecorate` 経由で editorRef を直接呼ぶ、下記参照）。
  useEffect(() => {
    return ipc.onEditorMenuCommand((payload: EditorMenuCommandPayload) => {
      switch (payload.kind) {
        case 'textCommand':
          editorRef.current?.runTextCommand(payload.command);
          return;
        case 'setWrap':
          handleChangeEditorSettingsFromDialog({ wrap: payload.wrap });
          return;
        case 'toggleLineNumbers':
          handleChangeEditorSettingsFromDialog({ showLineNumbers: !editorSettings.showLineNumbers });
          return;
        case 'toggleWhitespace':
          handleChangeEditorSettingsFromDialog({ showWhitespace: !editorSettings.showWhitespace });
          return;
        case 'fontSize':
          if (payload.action === 'increase') applyFontSizeChange((size) => size + FONT_SIZE_STEP);
          else if (payload.action === 'decrease') applyFontSizeChange((size) => size - FONT_SIZE_STEP);
          else applyFontSizeChange(() => DEFAULT_EDITOR_SETTINGS.fontSize);
          return;
      }
    });
  }, [editorSettings.showLineNumbers, editorSettings.showWhitespace, handleChangeEditorSettingsFromDialog, applyFontSizeChange]);

  const setEditorWrapNode = useCallback((node: HTMLDivElement | null) => {
    if (editorWheelCleanup.current) {
      editorWheelCleanup.current();
      editorWheelCleanup.current = null;
    }
    if (!node) return;

    const handleWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyFontSizeChange((size) => size + (e.deltaY < 0 ? FONT_SIZE_STEP : -FONT_SIZE_STEP));
    };

    node.addEventListener('wheel', handleWheel, { passive: false });
    editorWheelCleanup.current = () => node.removeEventListener('wheel', handleWheel);
  }, [applyFontSizeChange]);

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
        // 【v3 M9a】ロック解除セッション配下は対象外（handleLockMemo 参照）。
        if (om && om.encrypted && !om.lockToken) {
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
        onRequestOpenFolder={handleRequestOpenTabFolder}
        onDropMemo={(destTabId, payload, copy) => void handleDropMemoOnTab(destTabId, payload, copy)}
        onDropExternalFolder={handleDropExternalFolder}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onRequestSearch={() => setShowSearchPanel(true)}
        alwaysOnTop={alwaysOnTop}
        onToggleAlwaysOnTop={handleToggleAlwaysOnTop}
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
              onOpenMemo={(memoName, encrypted, focusEditor, lockToken) =>
                void openMemoByName(memoName, encrypted, focusEditor, lockToken)
              }
              onToggleExpand={handleToggleExpand}
              onRequestCreate={handleRequestCreate}
              onRequestRename={handleRequestRename}
              onRequestDelete={handleRequestDelete}
              onRequestSetLabel={handleRequestSetLabel}
              onRequestEncrypt={handleRequestEncrypt}
              onRequestDecrypt={handleRequestDecrypt}
              onRequestChangePassword={handleRequestChangePassword}
              onRequestToggleLock={handleRequestToggleLock}
              onRequestProperties={handleRequestProperties}
              onRequestLockNode={handleRequestLockNode}
              onRequestUnlockNode={handleRequestUnlockNode}
              onLocalMove={(names, anchor, zone, anchorLockToken, srcLockToken) =>
                void handleLocalMove(names, anchor, zone, anchorLockToken, srcLockToken)
              }
              onLocalCopy={(names, anchor, zone, anchorLockToken, srcLockToken) =>
                void handleLocalCopy(names, anchor, zone, anchorLockToken, srcLockToken)
              }
              uiFontScale={uiFontScale}
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
                  {/* v3 M9a: ロック解除セッション配下は「🔒 暗号化」ではなく専用表示にする
                      （M6 個別暗号化の「ロック」ボタンはセッションには効かないため区別する）。 */}
                  {openMemo.lockToken
                    ? '🔒 ロック解除セッション'
                    : openMemo.encrypted
                      ? '🔒 暗号化'
                      : `encoding: ${openMemo.encoding}`}{' '}
                  / eol: {openMemo.eol}
                </span>
                <button type="button" onClick={() => void handleSave()} disabled={!dirty}>
                  保存
                </button>
                {openMemo.encrypted && !openMemo.lockToken && (
                  <button type="button" onClick={() => void handleLockMemo()}>
                    ロック
                  </button>
                )}
                {/* v3 M10c: `.txt`→`.md`変換（DESIGNv3 §2.4）。暗号化メモ・ノードロックセッション
                    配下は memo:convertFormat 対象外（M10a）のためボタン自体を出さない。
                    `.md`→`.txt`はMarkdownToolbar側（下）に置く。 */}
                {openMemo.format !== 'markdown' && !openMemo.encrypted && !openMemo.lockToken && (
                  <button type="button" onClick={() => handleConvertFormat('md')} title="拡張子を .md に変換します（本文は変換しません）">
                    Markdownに変換
                  </button>
                )}
              </div>
              {/* v3 M10c: ライブプレビュー編集中専用ツールバー（`.md`メモのみ表示）。 */}
              {openMemo.format === 'markdown' && (
                <MarkdownToolbar
                  previewMode={previewMode}
                  onTogglePreview={() => setPreviewMode((prev) => !prev)}
                  canConvertToTxt={!openMemo.encrypted && !openMemo.lockToken}
                  onConvertToTxt={() => handleConvertFormat('txt')}
                  onDecorate={handleDecorate}
                />
              )}
              <CodeMirrorEditor
                key={`${openMemo.tabId}:${openMemo.memoName}:${reloadGeneration}`}
                ref={editorRef}
                initialContentLF={contentLF}
                onChange={handleEditorChange}
                onStats={handleEditorStats}
                onSave={() => void handleSave()}
                settings={editorSettings}
                autoFocus={editorAutoFocus}
                revealTarget={revealTarget}
                readOnly={
                  (conflictInfo !== null && conflictInfo.tabId === openMemo.tabId && conflictInfo.memoName === openMemo.memoName) ||
                  (cryptoDialog !== null && cryptoDialog.tabId === openMemo.tabId && cryptoDialog.memoName === openMemo.memoName) ||
                  // M9a-R2-01: openMemo.lockToken を scope hint に使い、別スコープの同名ノードの
                  // 編集ロック状態を誤って参照しないようにする。
                  !!findTreeNodeInScope(tree, openMemo.memoName, openMemo.lockToken)?.locked
                }
                linkOpenTrigger={linkSettings.openTrigger}
                onLinkClick={handleLinkClick}
                markdown={openMemo.format === 'markdown'}
                previewMode={previewMode}
                onImagePasteRequest={handleImagePasteRequest}
                onUnsupportedImagePaste={handleUnsupportedImagePaste}
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
          onCancel={() => {
            confirmDialog.onCancel?.();
            setConfirmDialog(null);
          }}
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
      {propertiesDialog && (
        <PropertiesDialog
          properties={propertiesDialog.properties}
          onRevealInFolder={() =>
            void ipc.revealMemoInFolder({ tabId: propertiesDialog.tabId, memoName: propertiesDialog.properties.memoName })
          }
          onClose={() => setPropertiesDialog(null)}
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
          uiFontScale={uiFontScale}
          onChangeUiFontScale={handleChangeUiFontScale}
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
          openAtLogin={openAtLogin}
          onChangeOpenAtLogin={handleChangeOpenAtLogin}
          onClose={() => setShowSettingsDialog(false)}
        />
      )}
    </div>
  );
}
