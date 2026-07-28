// src/renderer/components/Tree/Tree.tsx
// 仮想化ツリー本体（DESIGN §2.2）。開閉/複数選択(Ctrl/Shift)/DND(並べ替え・階層変更・タブ間移動)/
// 右クリックメニュー(追加位置・リネーム・複製・削除・ラベル)を扱う。
// 外部の仮想化/DND ライブラリは追加せず、固定行高のウィンドウイング + ネイティブ HTML5 DnD で実装
// （docs/milestones/M2-tree-ui.md「仮想化ツリー」「DND」、PLAN §0 は tanstack/react-virtual や
// dnd-kit を候補として例示するが「developer は妥当な理由があれば変更してよい」との明記に基づき、
// 依存追加のリスクを避け軽量な自前実装を採用した）。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent
} from 'react';
import type { AddPosition } from '@shared/ipc-contract';
import type { TreeNode } from '@shared/models';
import { rangeSelect, selectSingle, toggleSelection, type SelectionState } from '../../store/selection';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TreeRow, BASE_ROW_HEIGHT } from './TreeRow';
import {
  computeVirtualRange,
  findSessionParentLockToken,
  findSessionRootNode,
  findTreeNodeInScope,
  flattenVisibleTree,
  isLockBoundaryMoveAllowed,
  MEMO_DND_MIME,
  type DropZone,
  type MemoDragPayload
} from './treeView';

const LABEL_PRESETS: { name: string; color: string | null }[] = [
  { name: 'なし', color: null },
  { name: '赤', color: '#e05a5a' },
  { name: '青', color: '#4a90d9' },
  { name: '緑', color: '#4caf50' },
  { name: '黄', color: '#e0c040' }
];

export interface TreeProps {
  tabId: string;
  tree: readonly TreeNode[];
  openMemoName: string | null;
  selection: SelectionState;
  onSelectionChange: (next: SelectionState) => void;
  /** `focusEditor` 省略時（クリック等）は既定でエディタへフォーカス移動する。矢印キー連続移動の
   * 間はツリー側にフォーカスを残したいため（ユーザー要望）、その場合のみ明示的に `false` を渡す。
   * `lockToken`（M9a-R2-01）: 対象行自身が保持する `lockToken`（行データそのものから取得できる
   * ため取り違えようがない）。呼び出し元はこれを hint として `memoName` 文字列一致のみに頼らず
   * 対象ノードを解決する。 */
  onOpenMemo: (memoName: string, encrypted: boolean, focusEditor?: boolean, lockToken?: string) => void;
  onToggleExpand: (memoName: string, lockToken?: string) => void;
  /**
   * v3 M10c: `format`（省略時 'plain'=`.txt`）。新規メモ作成時に「通常メモ」「Markdownメモ」を
   * 選択できるUI（DESIGNv3 §2.4、docs/v3/milestones/M10c-markdown-toolbar-ui.md）。
   */
  onRequestCreate: (position: AddPosition, anchorMemoName?: string, anchorLockToken?: string, format?: 'plain' | 'markdown') => void;
  onRequestRename: (memoName: string, lockToken?: string) => void;
  onRequestDelete: (memoNames: string[], lockToken?: string) => void;
  onRequestSetLabel: (memoName: string, color: string | null, lockToken?: string) => void;
  /** パスワードを設定して暗号化する（平文メモのみ, M6）。 */
  onRequestEncrypt: (memoName: string) => void;
  /** 暗号化を解除して平文へ戻す（暗号化メモのみ, M6）。 */
  onRequestDecrypt: (memoName: string) => void;
  /** パスワードを変更する（暗号化メモのみ, M6）。 */
  onRequestChangePassword: (memoName: string) => void;
  /** 編集ロックの切替（本文編集のみ禁止。リネーム/削除等ファイル操作は対象外, ユーザー要望）。 */
  onRequestToggleLock: (memoName: string, lockToken?: string) => void;
  /** プロパティ画面を開く（ユーザー要望）。 */
  onRequestProperties: (memoName: string) => void;
  /** v3 M8: サブツリーをロックする（対象ノード=起点。M6個別暗号化とは別物, DESIGNv3 §1）。 */
  onRequestLockNode: (memoName: string) => void;
  /** v3 M8: ロック中サブツリーを解除する（`memoName` は難読化トークン）。 */
  onRequestUnlockNode: (memoName: string) => void;
  /**
   * v3 §1.14: ロックを恒久的に解除する（不可逆、`docs/v3/DESIGNv3.md` §1.14）。既存の
   * 「ロックを解除」（セッション開始）とは別操作。`targetToken` は対象ロック自身のトークン
   * （ロック中(セッション無し)プレースホルダなら自身の `memoName`、既にセッションが張られている
   * 起点ノードなら自身の `lockToken`）。`lockContextToken` は対象自体が入れ子ロックの場合の
   * 親セッションの `lockToken`（トップレベル対象なら `undefined`）。
   */
  onRequestRemoveNodeLock: (targetToken: string, lockContextToken: string | undefined) => void;
  /** 同一タブ内の並べ替え・階層変更（ファイル移動不要な場合は tree:updateStructure、ロック境界を
   * 跨ぐ「外→内」移動は実ファイルの暗号化変換を伴うため memo:move, v3 M9b）。`anchorLockToken`
   * はドロップ先アンカー行自身が保持する `lockToken`（M9a-R2-01 hint）。`srcLockToken` はドラッグ
   * 元の行自身が保持する `lockToken`（v3 M9b、「一方通行の金庫」判定用 hint）。 */
  onLocalMove: (
    draggedNames: string[],
    destAnchorMemoName: string,
    zone: DropZone,
    anchorLockToken?: string,
    srcLockToken?: string
  ) => void;
  /** 同一タブ内コピー（実ファイル複製が必要, memo:move copy:true）。`srcLockToken`/`anchorLockToken`
   * は onLocalMove と同じ意味（v3 M9b）。 */
  onLocalCopy: (
    draggedNames: string[],
    destAnchorMemoName: string,
    zone: DropZone,
    anchorLockToken?: string,
    srcLockToken?: string
  ) => void;
  /** UI 文字サイズ倍率（設定画面「外観」）。行高（仮想化・DnD 判定に使う固定高）をこれに連動させる。 */
  uiFontScale: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  /** null = 行ではなく空白部分の右クリック（ユーザー要望: ツリーが空でもメモを作成できるように）。 */
  memoName: string | null;
  /** M9a-R2-01: 右クリックされた行自身が保持する `lockToken`（行データそのものから取得、
   * 取り違えようがない）。`memoName` の再検索（`flatRows.find` 等）に頼らずそのまま保持しておき、
   * `buildContextMenuItems` の対象解決 hint として使う。 */
  lockToken?: string;
}

export function Tree({
  tabId,
  tree,
  openMemoName,
  selection,
  onSelectionChange,
  onOpenMemo,
  onToggleExpand,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onRequestSetLabel,
  onRequestEncrypt,
  onRequestDecrypt,
  onRequestChangePassword,
  onRequestToggleLock,
  onRequestProperties,
  onRequestLockNode,
  onRequestUnlockNode,
  onRequestRemoveNodeLock,
  onLocalMove,
  onLocalCopy,
  uiFontScale
}: TreeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragNames, setDragNames] = useState<string[] | null>(null);
  // v3 M9b: ドラッグ元の行自身が保持する lockToken（掴んだ行そのもの、取り違えようがない）。
  // 「一方通行の金庫」（DESIGNv3 §1.12）の事前拒否判定に使う。undefined = 通常領域からのドラッグ。
  const [dragLockToken, setDragLockToken] = useState<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<{ memoName: string; zone: DropZone } | null>(null);

  const rowHeight = Math.round(BASE_ROW_HEIGHT * uiFontScale);
  const flatRows = useMemo(() => flattenVisibleTree(tree), [tree]);
  const visibleOrder = useMemo(() => flatRows.map((r) => r.memoName), [flatRows]);
  const range = computeVirtualRange(flatRows.length, rowHeight, scrollTop, viewportHeight);
  const visibleRows = flatRows.slice(range.startIndex, range.endIndex);

  const handleScroll = useCallback((e: ReactUIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // F2 でリネーム（単一選択時のみ, ユーザー要望）。右クリックメニューの「名前変更」と同じ
  // onRequestRename に委譲する。
  // ↑/↓ は既定のスクロールではなく前後のメモへ移動する（ユーザー要望）。クリック時と同様に
  // 単一選択+オープンまで行う。仮想化のため、選択後は必要に応じて手動でスクロール位置を補正する。
  const handleTreeKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'F2') {
        if (selection.selected.size !== 1) return;
        e.preventDefault();
        const [memoName] = selection.selected;
        // M9a-R2-01 既知の限界: キーボード操作（F2）は特定の行への直接参照を持たないため、
        // `flatRows.find` による memoName 一致検索（同名ノードが複数スコープに同時存在する
        // 場合は取り違えうる, PLANv3 §7.3）に頼る。マウス操作（クリック/右クリック/ドラッグ）は
        // 行データそのものから hint を取得するため、この限界の対象外（AGENT_LOG参照）。
        const row = memoName ? flatRows.find((r) => r.memoName === memoName) : undefined;
        // v3 M8: ロック中(セッション無し)ノードは実名が無いためF2リネーム対象外
        // （右クリックメニューでも同様に非表示, buildContextMenuItems 参照）。
        if (memoName && !row?.nodeLocked) {
          onRequestRename(memoName, row?.lockToken);
        }
        return;
      }

      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (flatRows.length === 0) return;
      e.preventDefault();

      const currentName = selection.anchor ?? [...selection.selected][0] ?? null;
      const currentIndex = currentName ? flatRows.findIndex((r) => r.memoName === currentName) : -1;
      const nextIndex =
        currentIndex === -1
          ? e.key === 'ArrowDown'
            ? 0
            : flatRows.length - 1
          : e.key === 'ArrowDown'
            ? Math.min(currentIndex + 1, flatRows.length - 1)
            : Math.max(currentIndex - 1, 0);
      const nextRow = flatRows[nextIndex];
      if (!nextRow) return;

      onSelectionChange(selectSingle(nextRow.memoName));
      // 矢印キーでの連続移動中はツリー側にフォーカスを残す（ユーザー要望: 移動のたびに右ペイン
      // へフォーカスが奪われると、そのまま↑/↓を押し続けられなくなるため）。
      // v3 M8: ロック中(セッション無し)ノードは開こうとしない（handleRowClick と同様）。
      // nextRow は flatRows 中の特定の行そのものなので、その lockToken をそのまま hint として渡す
      // （M9a-R2-01）。
      if (!nextRow.nodeLocked) onOpenMemo(nextRow.memoName, nextRow.encrypted, false, nextRow.lockToken);

      const rowTop = nextIndex * rowHeight;
      const rowBottom = rowTop + rowHeight;
      const container = containerRef.current;
      if (container) {
        if (rowTop < scrollTop) container.scrollTop = rowTop;
        else if (rowBottom > scrollTop + viewportHeight) container.scrollTop = rowBottom - viewportHeight;
      }
    },
    [selection, flatRows, rowHeight, scrollTop, viewportHeight, onRequestRename, onSelectionChange, onOpenMemo]
  );

  // 開いているメモが変わったら（起動時の前回メモ復元/memo:リンク遷移/検索結果ジャンプ等）、
  // 対応する行が表示範囲内に入るようスクロール位置を補正する（ユーザー要望）。
  // `container.scrollTop` を直接読むことで、手動スクロール中の scrollTop state 更新のたびに
  // 再実行されるのを避ける（依存配列に scrollTop を含めない）。
  useEffect(() => {
    if (!openMemoName) return;
    const index = flatRows.findIndex((r) => r.memoName === openMemoName);
    if (index === -1) return;
    const container = containerRef.current;
    if (!container) return;
    const rowTop = index * rowHeight;
    const rowBottom = rowTop + rowHeight;
    if (rowTop < container.scrollTop) container.scrollTop = rowTop;
    else if (rowBottom > container.scrollTop + viewportHeight) container.scrollTop = rowBottom - viewportHeight;
  }, [openMemoName, flatRows, rowHeight, viewportHeight]);

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) setViewportHeight(node.clientHeight);
  }, []);

  const handleRowClick = useCallback(
    (memoName: string, encrypted: boolean, nodeLocked: boolean, lockToken: string | undefined, e: ReactMouseEvent) => {
      // F2 リネームはこのコンテナが DOM フォーカスを持っている必要がある（行クリック時点で
      // 明示的にフォーカスしておく。ユーザー要望）。
      containerRef.current?.focus();
      if (e.shiftKey) {
        onSelectionChange(rangeSelect(selection, visibleOrder, memoName));
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        onSelectionChange(toggleSelection(selection, memoName));
        return;
      }
      onSelectionChange(selectSingle(memoName));
      // v3 M8: ロック中(セッション無し)ノードはクリックで開こうとしない（M6の「暗号化メモを
      // クリックでパスワード入力ダイアログへ」という既存挙動と衝突するため。ロック解除は
      // 右クリックメニュー「ロックを解除」専用の導線, DESIGNv3 §1.11）。
      if (nodeLocked) return;
      // クリックされた行そのものの lockToken を hint として渡す（M9a-R2-01、取り違えようがない）。
      onOpenMemo(memoName, encrypted, undefined, lockToken);
    },
    [selection, visibleOrder, onSelectionChange, onOpenMemo]
  );

  const handleContextMenu = useCallback(
    (memoName: string, lockToken: string | undefined, e: ReactMouseEvent) => {
      e.preventDefault();
      if (!selection.selected.has(memoName)) {
        onSelectionChange(selectSingle(memoName));
      }
      // 右クリックされた行そのものの lockToken を保持する（M9a-R2-01）。
      setContextMenu({ x: e.clientX, y: e.clientY, memoName, lockToken });
    },
    [selection, onSelectionChange]
  );

  const handleDragStart = useCallback(
    (memoName: string, lockToken: string | undefined, nodeLocked: boolean | undefined, e: ReactDragEvent) => {
      const names = selection.selected.has(memoName) ? [...selection.selected] : [memoName];
      setDragNames(names);
      // v3 M9b: 実際に掴んだ行そのものの lockToken を代表値として保持する（取り違えようがない）。
      setDragLockToken(lockToken);
      // reviewer指摘 M9b-R1-01: 掴んだ行自身が nodeLocked（未解除の🔒プレースホルダ）かどうかも
      // 別途 payload へ含める（srcLockToken だけでは区別できないケースへの対処、treeView.ts
      // MemoDragPayload.srcNodeLocked のコメント参照）。
      const payload: MemoDragPayload = {
        srcTabId: tabId,
        memoNames: names,
        srcLockToken: lockToken,
        srcNodeLocked: nodeLocked || undefined
      };
      e.dataTransfer.setData(MEMO_DND_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    [selection, tabId]
  );

  // v3 M8: ロック中(セッション無し)ノードは children が常に空でなければならない（DESIGNv3 §1.2/
  // §1.6）。'child' ドロップ（=その配下へ入れる操作）だけは 'after'（兄弟として後ろへ）へ丸める。
  // 'before'/'after'（ロック済みノード自体を並べ替える操作）は許可する（DESIGNv3 §1.1 の
  // 「配下への」構造変更禁止はプレースホルダ自身の並び替えまでは制限しない）。
  function clampZoneForLockedTarget(zone: DropZone, nodeLocked: boolean | undefined): DropZone {
    return nodeLocked && zone === 'child' ? 'after' : zone;
  }

  const handleRowDragOver = useCallback((memoName: string, zone: DropZone, nodeLocked?: boolean) => {
    setDropTarget({ memoName, zone: clampZoneForLockedTarget(zone, nodeLocked) });
  }, []);

  const handleRowDrop = useCallback(
    (memoName: string, zone: DropZone, e: ReactDragEvent, nodeLocked?: boolean, lockToken?: string) => {
      setDropTarget(null);
      const raw = e.dataTransfer.getData(MEMO_DND_MIME);
      // ドラッグ状態はここでクリアする前に控えておく（v3 M9b の事前拒否判定・呼び出し元への
      // hint 引き渡しに使う）。
      const srcLockToken = dragLockToken;
      setDragNames(null);
      setDragLockToken(undefined);
      if (!raw) return;
      let payload: MemoDragPayload;
      try {
        payload = JSON.parse(raw) as MemoDragPayload;
      } catch {
        return;
      }
      if (payload.srcTabId !== tabId) return; // タブ間ドロップは TabBar 側 (memo:move) が扱う。
      if (payload.memoNames.includes(memoName)) return; // 自分自身へのドロップは無視。
      // v3 M9b: 「一方通行の金庫」の事前拒否（多層防御の2段目。1段目は TreeRow.tsx の
      // canAcceptDrop による preventDefault 抑制。ネイティブ DnD の癖で万一ここへ到達しても
      // 再検証する）。IPC側（memoHandlers.ts handleLockBoundaryMove）でも同一ルールを再検証する。
      if (!isLockBoundaryMoveAllowed(srcLockToken, lockToken)) return;
      const effectiveZone = clampZoneForLockedTarget(zone, nodeLocked);
      const copy = e.ctrlKey;
      if (copy) {
        onLocalCopy(payload.memoNames, memoName, effectiveZone, lockToken, srcLockToken);
      } else {
        // ドロップ先アンカー行そのものの lockToken を hint として渡す（M9a-R2-01）。
        // srcLockToken はドラッグ元行自身の lockToken hint（v3 M9b）。
        onLocalMove(payload.memoNames, memoName, effectiveZone, lockToken, srcLockToken);
      }
    },
    [tabId, onLocalMove, onLocalCopy, dragLockToken]
  );

  const buildContextMenuItems = useCallback(
    (memoName: string | null, lockToken: string | undefined): ContextMenuItem[] => {
      // 空白部分の右クリック（ユーザー要望）: ツリーが空でも「メモを作成」だけは常に出す。
      // v3 M10c: 「通常メモ」「Markdownメモ」を選べるサブメニューにする（DESIGNv3 §2.4）。
      if (memoName === null) {
        return [
          {
            label: 'メモを作成',
            submenu: [
              { label: '通常メモ', onSelect: () => onRequestCreate('last', undefined, undefined, 'plain') },
              { label: 'Markdownメモ', onSelect: () => onRequestCreate('last', undefined, undefined, 'markdown') }
            ]
          }
        ];
      }
      const multi = selection.selected.size > 1 && selection.selected.has(memoName);
      // M6: 暗号化/暗号化解除/パスワード変更は単一選択時のみ（rename/duplicate と同様の制約）。
      // M9a-R2-01: `lockToken` は右クリックされた行そのものから ContextMenuState に保持しておいた
      // hint（handleContextMenu 参照）。`flatRows.find((r) => r.memoName === memoName)`
      // （文字列一致のみ）だと、同名ノードが複数スコープに同時存在する場合（PLANv3 §7.3）に
      // 誤った行の情報を参照しうるため、scope-qualified な `findTreeNodeInScope` を使う。
      const row = findTreeNodeInScope(tree, memoName, lockToken);
      const rowEncrypted = row?.encrypted ?? false;
      const rowLocked = row?.locked ?? false;
      const rowNodeLocked = row?.nodeLocked ?? false;
      // v3 M9a: ロック解除セッション配下（起点＋子孫、row.lockToken あり）は、M6 個別暗号化
      // （暗号化解除/パスワード変更/暗号化する）・入れ子ロック（サブツリーをロック）・
      // プロパティが今回のレンダラ配線の対象外（crypto:encryptMemo 等・memo:getProperties は
      // lockContext を運べない、crypto:lockNode/unlockNode の入れ子ロックは別タスクの検討事項,
      // AGENT_LOG参照）。誤操作でわかりにくい NOT_FOUND 等に繋がるため導線ごと隠す。
      const rowInSession = !!row?.lockToken;
      // v3 §1.14: この行自身が、ある解除中セッションの「起点ノード」かどうか（= row.lockToken の
      // セッションの起点が、他ならぬこの row 自身であること）。「ロックを完全に解除する」を
      // 既にセッションが張られている起点ノードからも呼べるようにするために必要
      // （DESIGNv3 §1.14「トリガー」）。
      const sessionRootOfRow = row?.lockToken ? findSessionRootNode(tree, row.lockToken) : null;
      const isSessionOrigin = !!sessionRootOfRow && sessionRootOfRow === row;
      // ユーザー要望: 前/後/子の3項目は「メモを作成」1つに統一し、常に後ろ（'after'）に追加する。
      // v3 M10c: 「通常メモ」「Markdownメモ」を選べるサブメニューにする（DESIGNv3 §2.4）。
      const items: ContextMenuItem[] = [
        {
          label: 'メモを作成',
          submenu: [
            { label: '通常メモ', onSelect: () => onRequestCreate('after', memoName, lockToken, 'plain') },
            { label: 'Markdownメモ', onSelect: () => onRequestCreate('after', memoName, lockToken, 'markdown') }
          ]
        }
      ];

      // v3 M8: ロック中(セッション無し)ノードは「🔒(ロック中)」プレースホルダであり、実名が無い
      // ため名前変更/編集ロック/暗号化/ラベル/プロパティ等は一切意味を持たない（DESIGNv3 §1.2
      // 「🔒以外の情報を一切見せない」）。単一選択時のみ「ロックを解除」「ロックを完全に解除する」
      // を出す。
      // v3 §1.15（確定・2026-07-28ユーザー指摘反映）: 「削除」はこのメニューから撤去する
      // （旧コメントは「複数選択が絡む場合も削除だけを許可する」としていたが、実装は単一選択時も
      // 常に削除を出しており記述と食い違っていた＝古い不正確なコメントだった。削除するには
      // 「ロックを解除」でセッションに入ってから起点ノードごと削除する、または「ロックを完全に
      // 解除する」してから通常のメモとして削除する、いずれかを経由することを必須にする）。
      if (rowNodeLocked) {
        if (!multi) {
          items.push(
            { label: 'ロックを解除', onSelect: () => onRequestUnlockNode(memoName), separatorBefore: true },
            { label: 'ロックを完全に解除する', onSelect: () => onRequestRemoveNodeLock(memoName, lockToken) }
          );
        }
        return items;
      }

      if (!multi) {
        items.push(
          { label: '名前変更', onSelect: () => onRequestRename(memoName, lockToken), separatorBefore: true },
          {
            label: rowLocked ? '編集ロックを解除' : '編集ロック',
            onSelect: () => onRequestToggleLock(memoName, lockToken)
          }
        );
        if (!rowInSession) {
          if (rowEncrypted) {
            items.push(
              { label: '暗号化を解除', onSelect: () => onRequestDecrypt(memoName), separatorBefore: true },
              { label: 'パスワードを変更', onSelect: () => onRequestChangePassword(memoName) }
            );
          } else {
            items.push({
              label: 'パスワードを設定して暗号化',
              separatorBefore: true,
              onSelect: () => onRequestEncrypt(memoName)
            });
          }
          // v3 M8: サブツリーをロック（対象配下にM6個別暗号化メモが混在する場合はIPC側で
          // LOCK_CONTAINS_ENCRYPTED として拒否される, DESIGNv3 §1.10）。
          items.push({ label: 'サブツリーをロック', onSelect: () => onRequestLockNode(memoName) });
        } else if (isSessionOrigin) {
          // v3 §1.14: 既にセッションが張られている起点ノードからも「ロックを完全に解除する」に
          // 到達できるようにする（セッションの有無を問わず常に新規パスワード入力を要求するため、
          // 事前にセッションを開いておく必要はない, DESIGNv3 §1.14「トリガー」）。対象自身の
          // トークンは row.lockToken（= 右クリック時に保持しておいた lockToken と同一値）。
          // lockContext は、この起点ノードを直接含んでいる外側セッションの lockToken
          // （トップレベルなら undefined、入れ子ロックの内側なら外側セッションの lockToken）。
          items.push({
            label: 'ロックを完全に解除する',
            separatorBefore: true,
            onSelect: () => onRequestRemoveNodeLock(lockToken as string, findSessionParentLockToken(tree, lockToken as string))
          });
        }
      }
      // v3 §1.15: 選択集合(selection.selected)全体を走査し、ロック中(セッション無し)ノードが
      // 1件でも含まれる場合は削除操作全体をブロックする（部分適用・黙ったスキップはしない）。
      // 右クリックされた行自身は既に rowNodeLocked===false（上の早期 return を通過済み）のため、
      // ここでは選択集合の「他の」要素だけを確認すればよい。同名ノードが複数スコープに同時存在
      // する場合の完全なスコープ分離は未対応（既存の M9a-R2-01 残存範囲と同水準）。
      const multiSelectionHasLockedNode =
        multi && [...selection.selected].some((n) => flatRows.find((r) => r.memoName === n)?.nodeLocked === true);
      if (!multiSelectionHasLockedNode) {
        items.push({
          label: '削除',
          danger: true,
          separatorBefore: true,
          onSelect: () => onRequestDelete(multi ? [...selection.selected] : [memoName], lockToken)
        });
      }
      if (!multi) {
        items.push({
          label: 'アイコン',
          separatorBefore: true,
          submenu: LABEL_PRESETS.map((preset) => ({
            label: preset.name,
            swatchColor: preset.color,
            onSelect: () => onRequestSetLabel(memoName, preset.color, lockToken)
          }))
        });
        if (!rowInSession) {
          items.push({ label: 'プロパティ', onSelect: () => onRequestProperties(memoName) });
        }
      }
      return items;
    },
    [
      tree,
      flatRows,
      selection,
      onRequestCreate,
      onRequestRename,
      onRequestDelete,
      onRequestSetLabel,
      onRequestEncrypt,
      onRequestDecrypt,
      onRequestChangePassword,
      onRequestToggleLock,
      onRequestLockNode,
      onRequestUnlockNode,
      onRequestRemoveNodeLock,
      onRequestProperties
    ]
  );

  return (
    <div className="tree-toolbar-wrap">
      <div
        className="tree-scroll"
        ref={measureRef}
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
        onScroll={handleScroll}
        onContextMenu={(e) => {
          // 行ではなく空白部分の右クリック（ユーザー要望: ツリーが空でもメモを作成できるように）。
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, memoName: null });
          }
        }}
      >
        <div className="tree-spacer" style={{ height: range.paddingTop + range.paddingBottom + visibleRows.length * rowHeight }}>
          {visibleRows.map((row, i) => (
            <TreeRow
              // M9a-R2-01: memoName のみだと、ロック解除セッション配下はセッション単位でのみ
              // 一意（PLANv3 §7.3）という設計上、同名ノードが同時に複数スコープに存在した際に
              // React の key が重複し描画/イベントの取り違えを招く。lockToken を含めて一意にする。
              key={`${row.lockToken ?? ''}:${row.memoName}`}
              row={row}
              top={range.paddingTop + i * rowHeight}
              rowHeight={rowHeight}
              selected={selection.selected.has(row.memoName)}
              isOpenMemo={openMemoName === row.memoName}
              isDragging={dragNames?.includes(row.memoName) ?? false}
              dropZone={dropTarget?.memoName === row.memoName ? dropTarget.zone : null}
              // v3 M9b: ドラッグ中でなければ常に許可（dragNames が null）。ドラッグ中は「一方通行の
              // 金庫」判定（掴んだ行の dragLockToken → この行の lockToken）で可否を決める。
              canAcceptDrop={!dragNames || isLockBoundaryMoveAllowed(dragLockToken, row.lockToken)}
              onClick={(e) => handleRowClick(row.memoName, row.encrypted, row.nodeLocked ?? false, row.lockToken, e)}
              onContextMenu={(e) => handleContextMenu(row.memoName, row.lockToken, e)}
              onToggleExpand={() => onToggleExpand(row.memoName, row.lockToken)}
              onDragStart={(e) => handleDragStart(row.memoName, row.lockToken, row.nodeLocked, e)}
              onDragOver={(_e, zone) => handleRowDragOver(row.memoName, zone, row.nodeLocked)}
              onDragLeave={() => setDropTarget((prev) => (prev?.memoName === row.memoName ? null : prev))}
              onDrop={(e, zone) => handleRowDrop(row.memoName, zone, e, row.nodeLocked, row.lockToken)}
              onDragEnd={() => {
                setDragNames(null);
                setDragLockToken(undefined);
                setDropTarget(null);
              }}
            />
          ))}
        </div>
        {flatRows.length === 0 && (
          <div className="tree-empty-state">
            <button type="button" onClick={() => onRequestCreate('last')}>
              メモを作成
            </button>
          </div>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems(contextMenu.memoName, contextMenu.lockToken)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
