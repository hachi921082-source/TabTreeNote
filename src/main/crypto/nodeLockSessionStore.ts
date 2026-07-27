// src/main/crypto/nodeLockSessionStore.ts
// v3 M8: ロック解除中サブツリーのセッション（対応表・復号済み構造・鍵）をメインのメモリ上に
// のみ保持する（永続化しない, docs/v3/DESIGNv3.md §1.5「常駐セッション方式」）。
// 既存 src/main/crypto/sessionKeyStore.ts と対称の設計（キーは `(tabId, lockToken)` の組）。
//
// v3 M9a（docs/v3/milestones/M9a-node-lock-session-ops.md）で `parentLockToken`
// （入れ子ロックの親セッション参照, PLANv3 §7.4）を追加した。セッション中の構造変更・入れ子ロック
// の再暗号化・永続化ロジック自体は src/main/crypto/nodeLock.ts 側（`persistNodeLockSession`）に
// 置く（本ストアはあくまでメモリ上のデータ保持に専念する）。
import type { MetaTreeNode, TreeNode } from '@shared/models';
import type { KdfParams } from './cipher';

export interface NodeLockSessionEntry {
  /** ブロブ/配下メモ本文の再暗号化に使う導出済み鍵。 */
  key: Buffer;
  saltB64: string;
  kdf: KdfParams;
  hint?: string;
  /** realName -> obfuscatedFileName（起点ノード自身の分も含む）。 */
  nameMap: Record<string, string>;
  /**
   * 【2026-07-26追記・v3 M10b前提】realName -> 'plain' | 'markdown'（`nameMap` と対、`NodeLockBlob`
   * から引き継ぐ。docs/v3/milestones/M10b-markdown-live-preview.md §0.1）。
   */
  formatMap: Record<string, 'plain' | 'markdown'>;
  /** 復号済みの子ツリー構造（実名のまま。ブロブ内は平文表現でよい, DESIGNv3 §1.3）。 */
  children: MetaTreeNode[];
  /** 起点ノード自身の元の表示名。 */
  realMemoName: string;
  /**
   * 【v3 M9a: 入れ子ロック】このセッションが別セッション配下で `lockContext` 指定により
   * 解除された場合、親セッションの `lockToken` を保持する（PLANv3 §7.4）。トップレベル
   * （タブ直下のロックを直接解除した場合）は `undefined`。`persistNodeLockSession` が
   * この値を辿って祖先セッションを再帰的に再暗号化・永続化する。
   */
  parentLockToken?: string;
}

const store = new Map<string, NodeLockSessionEntry>();

function makeKey(tabId: string, lockToken: string): string {
  return `${tabId} ${lockToken}`;
}

/** ロック解除成功時にセッションを登録する（既存があれば上書き）。 */
export function setNodeLockSession(tabId: string, lockToken: string, entry: NodeLockSessionEntry): void {
  store.set(makeKey(tabId, lockToken), entry);
}

/** セッション中の構造変更（v3 M9a、`memo:*`/`tree:updateStructure`/入れ子ロックの `lockContext` 分岐）
 * 等が参照する。未解除/失効済みなら `undefined`。 */
export function getNodeLockSession(tabId: string, lockToken: string): NodeLockSessionEntry | undefined {
  return store.get(makeKey(tabId, lockToken));
}

/** `crypto:relockNode`（再ロック）で破棄する。存在しないキーの削除は no-op（冪等）。 */
export function deleteNodeLockSession(tabId: string, lockToken: string): void {
  store.delete(makeKey(tabId, lockToken));
}

/**
 * 【v3 M9c】`crypto:relockAllInTab`（タブ切替時のセッション一括破棄, DESIGNv3 §1.11・
 * PLANv3 §5.5/§7.6）で使う。指定 `tabId` に紐づく全セッション（入れ子ロックの子セッションを
 * 含む。子セッションのキーも同じ `tabId` で登録されているため、親子関係を辿らず単純に
 * `tabId` が一致するキーを全て削除すれば足りる）を破棄する。対象タブにセッションが1件も
 * 無い場合は何もせず成功扱い（冪等、`relockNode` と同じ方針）。`makeKey` は `"${tabId}
 * ${lockToken}"` という半角スペース区切りのため、`tabId` 自体が `randomUUID()` 生成（空白を
 * 含まない）である前提で、`"${tabId} "` の前方一致により誤って他タブのキーを削除しないことを
 * 保証する。
 */
export function deleteAllNodeLockSessionsForTab(tabId: string): void {
  const prefix = `${tabId} `;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/**
 * ブロブの子ツリー（実名表現の `MetaTreeNode[]`）から、表示用 `TreeNode[]` を構築する
 * （`crypto:unlockNode` の返却値組み立て、および `metaStore.reconcile` のセッション中表示の
 * 両方から共用する）。各ノードに `lockToken` を付与し `encrypted` は常に `true`
 * （実ファイルは常に `.txtenc`, M8-node-lock-core.md §5.2 step4）。
 *
 * 子孫が自身の `lock` を持つ場合（入れ子ロック, PLANv3 §7.4）は、この構築関数自体は常に
 * 「ロック中」プレースホルダとして描画する。「このセッションの一部として直接編集可能ではない」
 * （リネーム/暗号化/プロパティ等の導線を隠す）ことは、`lockToken` の有無ではなく `nodeLocked`
 * フラグそのもので判定する（`buildContextMenuItems` 等、呼び出し元は既に `nodeLocked` を最優先で
 * チェックしている）。`lockToken` 自体は他の兄弟ノードと同じくこのセッションの `lockToken` を
 * 付与する（reviewer指摘 M9b-R1-01: 以前は付与しなかったため、レンダラ側の「一方通行の金庫」
 * （境界跨ぎ判定, DESIGNv3 §1.12）がこのプレースホルダを常に「通常領域からのドラッグ」と誤認し、
 * (a) 同一セッション内での並べ替えが `NOT_FOUND` で失敗する回帰、(b) 更に深刻な問題として
 * このプレースホルダ自体をクロスタブ移動する際に境界チェックを素通りする穴を生んでいた。
 * `TreeNode.lockToken` のドキュメント本来の意味「起点＋子孫全て」（models.ts 参照）にも、
 * 子孫全てに付与するこちらの挙動の方が合致する）。入れ子ロックの解除自体は v3 M9a で実装済みで、
 * `crypto:unlockNode` に `lockContext:{lockToken}`（このセッションの `lockToken`）を渡すことで
 * 別セッションとして開始でき、その際は `buildOriginTreeNode` が新しいセッション用に別の `TreeNode`
 * を組み立てて返す（このセッション自身の表示ツリーとは独立。呼び出し側=レンダラが両者を関連付けて
 * 描画する）。
 */
export function buildSessionTreeNodes(
  children: readonly MetaTreeNode[],
  lockToken: string,
  formatMap: Readonly<Record<string, string>>
): TreeNode[] {
  return children.map((n) => {
    if (n.lock) {
      // 入れ子ロック済み(未解除)プレースホルダには format を付与しない（実体はパスワード復号を
      // 経ないと分からないため `undefined` のまま, M10b-markdown-live-preview.md §0.1）。
      return {
        memoName: n.memoName,
        encrypted: true,
        expanded: false,
        nodeLocked: true,
        lockToken,
        children: []
      };
    }
    return {
      memoName: n.memoName,
      encrypted: true,
      expanded: n.expanded,
      label: n.label,
      editor: n.editor,
      lockToken,
      format: formatMap[n.memoName] === 'markdown' ? 'markdown' : 'plain',
      children: buildSessionTreeNodes(n.children, lockToken, formatMap)
    };
  });
}

/**
 * ロック解除セッションの起点ノード自身を表す単一の `TreeNode` を構築する（`realMemoName` を
 * 表示名として使う。ロック中(セッション無し)の間は代わりに難読化トークンを `memoName` として
 * 表示するため, M8-node-lock-core.md §5.2 step4）。`crypto:unlockNode` の返却値、および
 * `metaStore.reconcile` が既存セッションを検出した際の表示の両方から共用する。
 */
export function buildOriginTreeNode(entry: NodeLockSessionEntry, lockToken: string): TreeNode {
  return {
    memoName: entry.realMemoName,
    encrypted: true,
    expanded: true,
    lockToken,
    format: entry.formatMap[entry.realMemoName] === 'markdown' ? 'markdown' : 'plain',
    children: buildSessionTreeNodes(entry.children, lockToken, entry.formatMap)
  };
}
