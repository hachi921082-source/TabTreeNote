// src/renderer/components/Tree/treeView.ts
// ツリー描画・DND 用の純粋ヘルパー（仮想化のための可視行フラット化・ドロップ位置計算・
// TreeNode(実行時, readonly, encrypted付き) <-> MetaTreeNode(永続化用) 変換, data-model.md §1）。
import type { AddPosition } from '@shared/ipc-contract';
import type { Label, MetaTreeNode, TreeNode } from '@shared/models';

/** ツリー行の DND で使うカスタム MIME タイプ（Tree からドラッグし TabBar 等へドロップする際の payload）。 */
export const MEMO_DND_MIME = 'application/x-ttn-memo';

export interface MemoDragPayload {
  srcTabId: string;
  memoNames: string[];
  /**
   * v3 M9b: ドラッグ元の行（実際に掴んだ行そのもの）が保持する `lockToken`（ロック解除セッション
   * 配下なら truthy）。「一方通行の金庫」（DESIGNv3 §1.12）の事前拒否判定に使う。複数選択で
   * 異なるスコープが混在する場合の扱いは、掴んだ行自身のスコープを代表値として扱う
   * （M9a-R2-01 以来の既存の残存範囲＝同名ノード混在時の完全な選択状態スコープ分離は未対応、
   * AGENT_LOG参照。掴んだ行は取り違えようがなく厳密）。
   */
  srcLockToken?: string;
  /**
   * v3 M9b（reviewer指摘 M9b-R1-01対応）: ドラッグ元の行自身が `nodeLocked`（未解除・ロック中の
   * 🔒プレースホルダ、トップレベル/入れ子いずれも）かどうか。`srcLockToken` は「ドラッグ元が
   * ロック解除セッション配下にあるか」を示すスコープ情報だが、トップレベルの `nodeLocked`
   * （セッション自体が存在しない）は元々スコープが「通常領域」であるため `srcLockToken` だけでは
   * 区別できない。TabBar へのクロスタブ移動は宛先が常に「通常領域」固定（`destPosition:'last'`,
   * セッション指定不可）で `srcLockToken` の有無だけでは「外→内」相当の判定ができてしまうため、
   * このフラグで「ロック中の中身そのものを移動しようとしている」ことを別途明示し、
   * `handleDropMemoOnTab` がスコープに関わらず一律拒否できるようにする（DESIGNv3 §1.1
   * 「ロック中はあらゆる構造変更操作を禁止」。パスワード入力を経ずに暗号化済みサブツリーが
   * 平文フォルダ間を物理移動してしまう穴の防止）。
   */
  srcNodeLocked?: boolean;
}

export interface FlatTreeRow {
  memoName: string;
  encrypted: boolean;
  expanded: boolean;
  hasChildren: boolean;
  depth: number;
  label?: Label;
  locked?: boolean;
  /** v3 M8: true = ロック中(セッション無し)の起点ノード。常に「🔒(ロック中)」表示、子は無い扱い。 */
  nodeLocked?: boolean;
  /** v3 M8: ロック解除セッション配下（起点＋子孫全て）に付与。 */
  lockToken?: string;
}

/** 開閉状態（expanded）を反映して、現在表示すべき行だけをフラットな配列にする（仮想化の入力）。 */
export function flattenVisibleTree(nodes: readonly TreeNode[], depth = 0, out: FlatTreeRow[] = []): FlatTreeRow[] {
  for (const node of nodes) {
    out.push({
      memoName: node.memoName,
      encrypted: node.encrypted,
      expanded: node.expanded,
      hasChildren: node.children.length > 0,
      depth,
      label: node.label,
      locked: node.locked,
      nodeLocked: node.nodeLocked,
      lockToken: node.lockToken
    });
    if (node.expanded && node.children.length > 0) {
      flattenVisibleTree(node.children, depth + 1, out);
    }
  }
  return out;
}

/** `tab:openTree` の実行時ツリー（`encrypted` 付き readonly）から永続化用 `MetaTreeNode[]` を作る。 */
export function toMetaTree(nodes: readonly TreeNode[]): MetaTreeNode[] {
  return nodes.map((n) => ({
    memoName: n.memoName,
    expanded: n.expanded,
    label: n.label,
    editor: n.editor,
    locked: n.locked,
    children: toMetaTree(n.children)
  }));
}

/** ツリー中から指定 memoName のノードを深さ優先で探す（編集ロック判定等に使う）。
 * 【M9a-R2-01 既知の限界】`memoName` の文字列一致のみに頼るため、ロック解除セッション配下は
 * セッション単位でのみ一意（PLANv3 §7.3）という設計上、タブ直下・複数セッション間で同名ノードが
 * 同時に存在する場合は取り違えうる。ユーザーが実際に操作した特定の行を対象にする箇所では、
 * 代わりに `findTreeNodeInScope`（対象ノード自身の `lockToken` を呼び出し元が hint として渡す
 * 版）を使うこと。本関数は hint が無い/不要な限定的な用途（キーボード操作等の残存範囲、
 * AGENT_LOG参照）にのみ残す。 */
export function findTreeNode(nodes: readonly TreeNode[], memoName: string): TreeNode | null {
  for (const n of nodes) {
    if (n.memoName === memoName) return n;
    const found = findTreeNode(n.children, memoName);
    if (found) return found;
  }
  return null;
}

/**
 * v3 M9a-R2-01: `findTreeNode` の scope-qualified 版。`(scopeLockToken, memoName)` の複合キーで
 * ノードを一意に解決する。`scopeLockToken` は対象ノード自身が保持する `lockToken`（タブ直下なら
 * `undefined`）で、呼び出し元（Tree.tsx の行データ＝ユーザーが実際にクリック/右クリックした行）
 * が把握している値をそのまま渡す。同名ノードが複数スコープに同時存在しても（PLANv3 §7.3）、
 * 意図した対象と異なるノードを取り違えない。
 */
export function findTreeNodeInScope(
  nodes: readonly TreeNode[],
  memoName: string,
  scopeLockToken: string | undefined
): TreeNode | null {
  for (const n of nodes) {
    if (n.memoName === memoName && n.lockToken === scopeLockToken) return n;
    const found = findTreeNodeInScope(n.children, memoName, scopeLockToken);
    if (found) return found;
  }
  return null;
}

/** ツリー中の指定 memoName のノードだけを `updater` で書き換えた新しい TreeNode[] を返す（不変更新）。
 * 【M9a-R2-01 既知の限界】`findTreeNode` と同じ理由でスコープを区別しない。 */
export function updateTreeNode(
  nodes: readonly TreeNode[],
  memoName: string,
  updater: (node: TreeNode) => TreeNode
): TreeNode[] {
  return nodes.map((n) => {
    if (n.memoName === memoName) return updater(n);
    if (n.children.length > 0) return { ...n, children: updateTreeNode(n.children, memoName, updater) };
    return n;
  });
}

/** `updateTreeNode` の scope-qualified 版（`findTreeNodeInScope` と同じ理由）。 */
export function updateTreeNodeInScope(
  nodes: readonly TreeNode[],
  memoName: string,
  scopeLockToken: string | undefined,
  updater: (node: TreeNode) => TreeNode
): TreeNode[] {
  return nodes.map((n) => {
    if (n.memoName === memoName && n.lockToken === scopeLockToken) return updater(n);
    if (n.children.length > 0) {
      return { ...n, children: updateTreeNodeInScope(n.children, memoName, scopeLockToken, updater) };
    }
    return n;
  });
}

/** v3 M9a: 指定 `lockToken` の起点ノード（`lockToken` が親と異なる値になる境界のノード）を探す。 */
export function findSessionRootNode(
  nodes: readonly TreeNode[],
  lockToken: string,
  parentLockToken?: string
): TreeNode | null {
  for (const node of nodes) {
    if (node.lockToken === lockToken && node.lockToken !== parentLockToken) return node;
    const found = findSessionRootNode(node.children, lockToken, node.lockToken);
    if (found) return found;
  }
  return null;
}

/**
 * v3 M9a: `lockContext` 指定の `memo:*`/`tree:updateStructure` 呼び出しが `LOCK_SESSION_NOT_FOUND`
 * で失敗した場合（対象セッションが既に破棄済み）の後始末。M9a-node-lock-session-ops.md の
 * エラーハンドリング方針「UIはツリーを再取得しロック中(🔒)表示へ戻す」を、ディスク再取得（
 * `tab:openTree` はセッションを認識しないため、他の場所で開いている別セッションまで巻き添えで
 * 表示上閉じてしまう）ではなく、対象セッションの起点ノードだけをローカルでプレースホルダに
 * 戻すことで実現する。起点ノード自身の `memoName`（実名）は失われるが、`lockToken` は起点の
 * 難読化ファイル名そのもの（PLANv3 §1.4）なのでプレースホルダの表示名として使える。
 */
export function collapseSessionToPlaceholder(nodes: readonly TreeNode[], lockToken: string): TreeNode[] {
  const root = findSessionRootNode(nodes, lockToken);
  if (!root) return nodes as TreeNode[];
  // M9a-R2-01: root.memoName は起点ノードの「現在の実名」であり、無関係な別スコープのノードと
  // 偶然同名になりうる（PLANv3 §7.3）。root 自身の lockToken（= 呼び出し元 root.lockToken）を
  // scope として渡し、取り違えを避ける。
  return updateTreeNodeInScope(nodes, root.memoName, root.lockToken, (n) => ({
    memoName: lockToken,
    encrypted: true,
    expanded: n.expanded,
    label: n.label,
    locked: n.locked,
    nodeLocked: true,
    children: []
  }));
}

/** ツリー中から指定 memoName 群を部分木ごと取り除いた新しい TreeNode[] を返す（不変更新）。
 * 【M9a-R2-01 既知の限界】`findTreeNode` と同じ理由でスコープを区別しない。 */
export function removeTreeNodesByNames(nodes: readonly TreeNode[], names: ReadonlySet<string>): TreeNode[] {
  const result: TreeNode[] = [];
  for (const n of nodes) {
    if (names.has(n.memoName)) continue;
    result.push(n.children.length > 0 ? { ...n, children: removeTreeNodesByNames(n.children, names) } : n);
  }
  return result;
}

/** `removeTreeNodesByNames` の scope-qualified 版。`names` は全て同一スコープ
 * （`scopeLockToken`）に属する前提で、呼び出し元（App.tsx handleRequestDelete）が事前に
 * 均質性を検証する（M9a-R2-02）。 */
export function removeTreeNodesByNamesInScope(
  nodes: readonly TreeNode[],
  names: ReadonlySet<string>,
  scopeLockToken: string | undefined
): TreeNode[] {
  const result: TreeNode[] = [];
  for (const n of nodes) {
    if (names.has(n.memoName) && n.lockToken === scopeLockToken) continue;
    result.push(
      n.children.length > 0 ? { ...n, children: removeTreeNodesByNamesInScope(n.children, names, scopeLockToken) } : n
    );
  }
  return result;
}

/**
 * `@shared/treeOps.insertTreeNode`（MetaTreeNode 版・破壊的）と同じ追加位置規則の、
 * TreeNode 版・非破壊コピー実装（v3 M9a: ロックセッション配下のローカル state を、ディスク
 * 再取得を挟まずその場で組み立てるために使う。`encrypted`/`lockToken` を保つ必要があるため
 * MetaTreeNode へ変換しての使い回しができない）。
 * 【M9a-R2-01 既知の限界】`anchorMemoName` の文字列一致のみに頼るため、同名ノードが複数
 * スコープに同時存在する場合は取り違えうる。hint がある場合は `insertTreeNodeAtInScope` を使うこと。
 */
export function insertTreeNodeAt(
  nodes: readonly TreeNode[],
  newNode: TreeNode,
  position: AddPosition,
  anchorMemoName?: string
): TreeNode[] {
  if (position === 'first') return [newNode, ...nodes];
  if (position === 'last') return [...nodes, newNode];
  if (!anchorMemoName) return [...nodes, newNode];

  let inserted = false;
  function walk(list: readonly TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];
    for (const n of list) {
      if (!inserted && n.memoName === anchorMemoName) {
        if (position === 'before') {
          result.push(newNode, n);
        } else if (position === 'child') {
          result.push({ ...n, children: [...n.children, newNode] });
        } else {
          result.push(n, newNode);
        }
        inserted = true;
        continue;
      }
      result.push(n.children.length > 0 ? { ...n, children: walk(n.children) } : n);
    }
    return result;
  }
  const next = walk(nodes);
  return inserted ? next : [...nodes, newNode];
}

/** `insertTreeNodeAt` の scope-qualified 版。`anchorMemoName` の探索を、それ自身が
 * `scopeLockToken` を保持するノードに限定する（M9a-R2-01）。`'first'`/`'last'`/アンカー無しの
 * 場合は呼び出し元が既にスコープ済みの `nodes`（セッションなら起点の `children`、タブ直下なら
 * トップレベル tree）を渡す前提のため、この関数自体で追加のフィルタは不要。 */
export function insertTreeNodeAtInScope(
  nodes: readonly TreeNode[],
  newNode: TreeNode,
  position: AddPosition,
  scopeLockToken: string | undefined,
  anchorMemoName?: string
): TreeNode[] {
  if (position === 'first') return [newNode, ...nodes];
  if (position === 'last') return [...nodes, newNode];
  if (!anchorMemoName) return [...nodes, newNode];

  let inserted = false;
  function walk(list: readonly TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];
    for (const n of list) {
      if (!inserted && n.memoName === anchorMemoName && n.lockToken === scopeLockToken) {
        if (position === 'before') {
          result.push(newNode, n);
        } else if (position === 'child') {
          result.push({ ...n, children: [...n.children, newNode] });
        } else {
          result.push(n, newNode);
        }
        inserted = true;
        continue;
      }
      result.push(n.children.length > 0 ? { ...n, children: walk(n.children) } : n);
    }
    return result;
  }
  const next = walk(nodes);
  return inserted ? next : [...nodes, newNode];
}

/**
 * v3 M9b: 「一方通行の金庫」（DESIGNv3 §1.12、docs/v3/milestones/M9b-node-lock-boundary-move.md）。
 * `srcLockToken`/`destLockToken` は、それぞれドラッグ元/ドロップ先の行が保持する `lockToken`
 * （`undefined` = 通常領域）。判定表:
 *   通常 → 通常                         : 許可
 *   通常 → セッション配下                : 許可（外→内）
 *   セッション配下 → 通常                : 禁止（内→外）
 *   セッション配下A → セッション配下B（別トークン）: 禁止（別ロック間）
 *   セッション配下A → セッション配下A（同一トークン）: 許可（境界を跨がない）
 * IPC 側（`memoHandlers.ts` `handleLockBoundaryMove`）でも同一ルールを再検証する（二重防御）。
 */
export function isLockBoundaryMoveAllowed(
  srcLockToken: string | undefined,
  destLockToken: string | undefined
): boolean {
  if (!srcLockToken) return true;
  return srcLockToken === destLockToken;
}

export type DropZone = 'before' | 'after' | 'child';

/** 行の矩形内でのポインタ縦位置比率（0=上端〜1=下端）から、ドロップ位置を判定する。 */
export function computeDropZone(offsetYRatio: number): DropZone {
  if (offsetYRatio < 0.25) return 'before';
  if (offsetYRatio > 0.75) return 'after';
  return 'child';
}

export function dropZoneToPosition(zone: DropZone): AddPosition {
  return zone;
}

export interface VirtualRange {
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
}

/** 固定行高の単純ウィンドウイング計算（仮想化ツリー、外部ライブラリ非依存）。 */
export function computeVirtualRange(
  totalCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8
): VirtualRange {
  if (totalCount === 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(totalCount, startIndex + visibleCount);
  const paddingTop = startIndex * rowHeight;
  const paddingBottom = (totalCount - endIndex) * rowHeight;
  return { startIndex, endIndex, paddingTop, paddingBottom };
}
