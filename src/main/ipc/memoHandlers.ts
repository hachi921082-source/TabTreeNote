// src/main/ipc/memoHandlers.ts
// メモ操作の IPC ハンドラ（PLAN §2.2）。M1 で read/readWithEncoding/save/create/rename。
// M2 で delete/duplicate/move、および tree:updateStructure を追加した
// （docs/milestones/M2-tree-ui.md「このフェーズで扱うディレクトリ/ファイル」: tabHandlers.ts /
// memoHandlers.ts の拡張、として本ファイルへ集約）。
// M3 で各操作の完了点から全文検索インデックス経路①（`searchIndex` の直接更新）を配線し、
// `evt:indexUpdated` を発火するようにした（docs/milestones/M3-search.md「インデックス差分更新の
// 2経路」。経路②=ファイル監視経由の反映は M4）。
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  IpcChannels,
  IpcEvents,
  type AddPosition,
  type IndexUpdatedPayload,
  type MemoDeleteArgs,
  type MemoDuplicateArgs,
  type MemoMoveArgs,
  type TreeUpdateStructureArgs,
  type TrashFallbackPayload
} from '@shared/ipc-contract';
import type { MemoInfo, MetaTreeNode, MemoReadResult, Result, SaveResult } from '@shared/models';
import { orderForBatchInsert } from '@shared/treeOps';
import { err, ok, wrapHandler } from '../util/result';
import { getTabFolderPath } from '../fs/tabService';
import { validateName, normalizeForCompare } from '../fs/pathSafety';
import {
  copyMemoFileToFolder,
  createEmptyMemoFile,
  deleteMemoFileDirect,
  deleteMemoFileViaTrash,
  duplicateMemoFile,
  moveMemoFileToFolder,
  pickAvailableName,
  readMemo,
  readMemoWithEncoding,
  renameMemoFile,
  saveMemo,
  scanTabFolder
} from '../fs/memoFileService';
import { findNode, insertNode, loadTabMeta, removeNode, renameNodeInTree, saveTabMeta } from '../fs/metaStore';
import type { DetectedEncoding } from '../fs/encoding';
import { moveMemoInIndex, removeMemo as removeMemoFromIndex, renameMemoInIndex, updateMemo as updateMemoIndex } from '../search/searchIndex';
import { deleteSessionKey, renameSessionKey } from '../crypto/sessionKeyStore';

/** `evt:indexUpdated` を発火する（全文検索インデックス更新, PLAN §2.7）。 */
function emitIndexUpdated(event: IpcMainInvokeEvent, tabId: string): void {
  const payload: IndexUpdatedPayload = { tabId };
  event.sender.send(IpcEvents.indexUpdated, payload);
}

async function isMemoNameTaken(folderPath: string, memoName: string, excludeName?: string): Promise<boolean> {
  const scanned = await scanTabFolder(folderPath);
  const normalizedTarget = normalizeForCompare(memoName);
  return scanned.some(
    (s) => normalizeForCompare(s.memoName) === normalizedTarget && s.memoName !== excludeName
  );
}

// ---------------------------------------------------------------------------
// M2: memo:delete / memo:duplicate / memo:move / tree:updateStructure のヘルパー
// （docs/milestones/M2-tree-ui.md「リネーム/移動/コピー/複製の同期順序」「削除」）。
// ---------------------------------------------------------------------------

/** ツリー中の指定ノードの部分木に含まれる全 memoName（自分自身を含む）を収集する。 */
function collectSubtreeNames(node: MetaTreeNode, out: string[] = []): string[] {
  out.push(node.memoName);
  for (const child of node.children) collectSubtreeNames(child, out);
  return out;
}

/**
 * `name` の祖先（自分自身は含まない）のいずれかが `selected` に含まれるか。
 * 親ごと選択された子孫を移動対象から除外する（親が動けば子も一緒に動くため二重処理を避ける）。
 */
function hasSelectedAncestor(tree: MetaTreeNode[], name: string, selected: ReadonlySet<string>): boolean {
  function search(nodes: MetaTreeNode[], ancestors: string[]): boolean | null {
    for (const node of nodes) {
      if (node.memoName === name) {
        return ancestors.some((a) => selected.has(a));
      }
      const found = search(node.children, [...ancestors, node.memoName]);
      if (found !== null) return found;
    }
    return null;
  }
  return search(tree, []) ?? false;
}

/** `candidateName` が `rootName` 自身、またはその部分木（子孫）に含まれるか（移動先の循環防止）。 */
function isSelfOrDescendant(tree: MetaTreeNode[], rootName: string, candidateName: string): boolean {
  if (rootName === candidateName) return true;
  const loc = findNode(tree, rootName);
  if (!loc) return false;
  return collectSubtreeNames(loc.node).includes(candidateName);
}

/**
 * サブツリーを複製しつつ、`reservedNames`（呼び出し側で随時追加していく可変集合）と衝突する
 * 名前だけ `pickAvailableName` で採番し直す。同一タブ内コピーは（同じフォルダ内に同名ファイルが
 * 既にあるため）全ノードが必ず改名され、タブ間コピーは衝突するノードのみ改名される。
 */
function cloneSubtreeWithUniqueNames(
  node: MetaTreeNode,
  reservedNames: Set<string>
): { node: MetaTreeNode; renames: { from: string; to: string }[] } {
  const renames: { from: string; to: string }[] = [];

  function walk(n: MetaTreeNode): MetaTreeNode {
    const finalName = pickAvailableName(reservedNames, n.memoName);
    reservedNames.add(finalName);
    renames.push({ from: n.memoName, to: finalName });
    return { memoName: finalName, expanded: n.expanded, label: n.label, editor: n.editor, children: n.children.map(walk) };
  }

  return { node: walk(node), renames };
}

export function registerMemoHandlers(): void {
  ipcMain.handle(
    IpcChannels.memo.read,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: { tabId: string; memoName: string }): Promise<Result<MemoReadResult>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      return readMemo(folder.value, args.memoName);
    })
  );

  ipcMain.handle(
    IpcChannels.memo.readWithEncoding,
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        args: { tabId: string; memoName: string; encoding: DetectedEncoding }
      ): Promise<Result<MemoReadResult>> => {
        const folder = getTabFolderPath(args.tabId);
        if (!folder.ok) return folder;
        return readMemoWithEncoding(folder.value, args.memoName, args.encoding);
      }
    )
  );

  ipcMain.handle(
    IpcChannels.memo.save,
    wrapHandler(
      async (
        event: IpcMainInvokeEvent,
        args: {
          tabId: string;
          memoName: string;
          contentLF: string;
          eol: MemoReadResult['eol'];
          encoding: DetectedEncoding;
          expectedHash?: string;
        }
      ): Promise<Result<SaveResult>> => {
        const folder = getTabFolderPath(args.tabId);
        if (!folder.ok) return folder;
        const result = await saveMemo(folder.value, args.memoName, args.contentLF, args.eol, args.encoding, args.expectedHash);
        if (result.ok) {
          // インデックス経路①（PLAN §5.2 step7）: 保存成功直後に本文を直接反映する。
          updateMemoIndex(args.tabId, args.memoName, false, args.contentLF);
          emitIndexUpdated(event, args.tabId);
        }
        return result;
      }
    )
  );

  ipcMain.handle(
    IpcChannels.memo.create,
    wrapHandler(
      async (
        event: IpcMainInvokeEvent,
        args: { tabId: string; name: string; position: AddPosition; anchorMemoName?: string }
      ): Promise<Result<MemoInfo>> => {
        const folder = getTabFolderPath(args.tabId);
        if (!folder.ok) return folder;
        const folderPath = folder.value;

        const nameCheck = validateName(args.name);
        if (!nameCheck.ok) return nameCheck;

        if (await isMemoNameTaken(folderPath, args.name)) {
          return err('NAME_DUPLICATE', `同名のメモが既に存在します: ${args.name}`);
        }

        // ①ストア更新（メモリ上のみ。NG ならここで既に return 済みなのでファイル操作しない）。
        const loaded = await loadTabMeta(folderPath);
        insertNode(loaded.metaTree, { memoName: args.name, expanded: true, children: [] }, args.position, args.anchorMemoName);

        // ②実ファイル操作。
        const createResult = await createEmptyMemoFile(folderPath, args.name);
        if (!createResult.ok) return createResult;

        // ③メタ JSON アトミック保存（直後）。
        await saveTabMeta(folderPath, loaded.metaTree);

        // インデックス経路①: 新規メモ（空本文）を反映する。
        updateMemoIndex(args.tabId, args.name, false, '');
        emitIndexUpdated(event, args.tabId);

        return ok<MemoInfo>({ memoName: args.name, encrypted: false });
      }
    )
  );

  ipcMain.handle(
    IpcChannels.memo.rename,
    wrapHandler(
      async (
        event: IpcMainInvokeEvent,
        args: { tabId: string; oldName: string; newName: string }
      ): Promise<Result<void>> => {
        const folder = getTabFolderPath(args.tabId);
        if (!folder.ok) return folder;
        const folderPath = folder.value;

        if (args.oldName === args.newName) return ok(undefined);

        const nameCheck = validateName(args.newName);
        if (!nameCheck.ok) return nameCheck;

        if (await isMemoNameTaken(folderPath, args.newName, args.oldName)) {
          return err('NAME_DUPLICATE', `同名のメモが既に存在します: ${args.newName}`);
        }

        // ①ストア更新（メモリ上のみ）。メタに未登録（実ファイルはあるがメタ未反映）の場合は
        // ルート末尾へ新規追加してフォールバックする。
        const loaded = await loadTabMeta(folderPath);
        const found = renameNodeInTree(loaded.metaTree, args.oldName, args.newName);
        if (!found) {
          loaded.metaTree.push({ memoName: args.newName, expanded: true, children: [] });
        }

        // ②実ファイル操作。
        const renameResult = await renameMemoFile(folderPath, args.oldName, args.newName);
        if (!renameResult.ok) return renameResult;

        // ③メタ JSON アトミック保存（直後）。
        await saveTabMeta(folderPath, loaded.metaTree);

        // インデックス経路①（PLAN §5.3 step4）: メモ名キーを更新する。
        renameMemoInIndex(args.tabId, args.oldName, args.newName);
        // 開封中の暗号化メモがリネームされてもセッション鍵を失わないよう引き継ぐ（M6, developer
        // 判断）。対象キーが無ければ何もしない（平文メモ/未開封メモのリネーム）。
        renameSessionKey(args.tabId, args.oldName, args.newName);
        emitIndexUpdated(event, args.tabId);

        return ok(undefined);
      }
    )
  );

  // --- memo:delete（既定はごみ箱送り。失敗時は evt:trashFallback → forceDirect 再 invoke, PLAN §2.6） ---
  ipcMain.handle(
    IpcChannels.memo.delete,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoDeleteArgs): Promise<Result<void>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      const loaded = await loadTabMeta(folderPath);
      const succeeded: string[] = [];
      const failed: string[] = [];

      for (const name of args.memoNames) {
        try {
          const res = args.forceDirect
            ? await deleteMemoFileDirect(folderPath, name)
            : await deleteMemoFileViaTrash(folderPath, name);
          if (res.ok || res.error.code === 'NOT_FOUND') {
            // 既に無い（外部で削除済み等）場合もメタ参照を除去する対象として成功扱いにする。
            succeeded.push(name);
          } else {
            failed.push(name);
          }
        } catch (e) {
          // 個々の失敗でバッチ全体を中断しない（既に削除済みの他メモのメタ反映は維持する）。
          // 内部診断ログ（00-core-principles.md §10 Fix8）。
          // eslint-disable-next-line no-console -- 内部診断ログ
          console.error('[main] memo:delete item failed', name, e);
          failed.push(name);
        }
      }

      // ①/③相当: 成功分のみメタから除去してアトミック保存する。
      for (const name of succeeded) removeNode(loaded.metaTree, name);
      if (succeeded.length > 0) {
        await saveTabMeta(folderPath, loaded.metaTree);
        // インデックス経路①: 削除成功分をインデックスからも除去する。
        for (const name of succeeded) {
          removeMemoFromIndex(args.tabId, name);
          // 削除された暗号化メモのセッション鍵が残らないよう破棄する（M6, developer 判断。
          // 実体が無くなった鍵をメモリに残さないための衛生上の後始末）。
          deleteSessionKey(args.tabId, name);
        }
        emitIndexUpdated(event, args.tabId);
      }

      if (failed.length > 0) {
        if (!args.forceDirect) {
          const payload: TrashFallbackPayload = {
            tabId: args.tabId,
            memoNames: failed,
            reason: 'ごみ箱へ送れませんでした（権限またはネットワークドライブの可能性があります）。'
          };
          event.sender.send(IpcEvents.trashFallback, payload);
        }
        return err('TRASH_FAILED', `削除できなかったメモがあります: ${failed.join(', ')}`);
      }
      return ok(undefined);
    })
  );

  // --- memo:duplicate ---
  ipcMain.handle(
    IpcChannels.memo.duplicate,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoDuplicateArgs): Promise<Result<MemoInfo>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      // ②実ファイル操作（複製先の名前は disk 走査から一意に採番されるため事前重複チェック不要）。
      const dup = await duplicateMemoFile(folderPath, args.memoName);
      if (!dup.ok) return dup;

      // ①/③相当: 元の直後（同階層）へ挿入してメタ保存。
      const loaded = await loadTabMeta(folderPath);
      const newNode: MetaTreeNode = { memoName: dup.value.newName, expanded: true, children: [] };
      insertNode(loaded.metaTree, newNode, 'after', args.memoName);
      await saveTabMeta(folderPath, loaded.metaTree);

      // インデックス経路①: 同一タブ内の複製として、元エントリを複製元に残したまま反映する。
      moveMemoInIndex(args.tabId, args.memoName, args.tabId, dup.value.newName, true);
      emitIndexUpdated(event, args.tabId);

      return ok<MemoInfo>({ memoName: dup.value.newName, encrypted: dup.value.encrypted });
    })
  );

  // --- memo:move（タブ間/タブ内移動・コピー, PLAN §2.2/§5.3） ---
  ipcMain.handle(
    IpcChannels.memo.move,
    wrapHandler(async (event: IpcMainInvokeEvent, args: MemoMoveArgs): Promise<Result<void>> => {
      const srcFolder = getTabFolderPath(args.srcTabId);
      if (!srcFolder.ok) return srcFolder;
      const destFolder = getTabFolderPath(args.destTabId);
      if (!destFolder.ok) return destFolder;
      if (args.memoNames.length === 0) return ok(undefined);

      const sameTab = args.srcTabId === args.destTabId;
      const srcLoaded = await loadTabMeta(srcFolder.value);
      const destLoaded = sameTab ? srcLoaded : await loadTabMeta(destFolder.value);

      // 親も選択されている子孫は対象から除外（親の移動に随伴するため）。
      const selectedSet = new Set(args.memoNames);
      const topLevelNames = args.memoNames.filter((name) => {
        const loc = findNode(srcLoaded.metaTree, name);
        return loc !== null && !hasSelectedAncestor(srcLoaded.metaTree, name, selectedSet);
      });
      if (topLevelNames.length === 0) {
        return err('NOT_FOUND', '移動/コピー対象のメモが見つかりません。');
      }

      // 循環防止: 同一タブ内で、選択ノード自身またはその子孫をアンカーに指定していないか。
      if (sameTab && args.destAnchorMemoName) {
        for (const name of topLevelNames) {
          if (isSelfOrDescendant(srcLoaded.metaTree, name, args.destAnchorMemoName)) {
            return err('NAME_INVALID', '選択したメモ自身またはその子孫へは移動できません。');
          }
        }
      }

      const destScanned = await scanTabFolder(destFolder.value);
      const destExistingNames = new Set(destScanned.map((s) => s.memoName));

      if (!args.copy) {
        // 移動: 名前は変えない。タブ間移動時のみ、宛先に同名の実ファイルがあれば拒否し
        // バッチ全体を中断する（部分適用しない＝①ストア更新前の重複チェック先行の原則）。
        if (!sameTab) {
          const conflicts: string[] = [];
          for (const name of topLevelNames) {
            const loc = findNode(srcLoaded.metaTree, name);
            if (!loc) continue;
            for (const n of collectSubtreeNames(loc.node)) {
              if (destExistingNames.has(n)) conflicts.push(n);
            }
          }
          if (conflicts.length > 0) {
            return err('NAME_DUPLICATE', `移動先に同名のメモが既に存在します: ${conflicts.join(', ')}`);
          }
        }

        // ①ストア更新: 選択ノードを src メタツリーから取り出す。
        const movedNodes: MetaTreeNode[] = [];
        for (const name of topLevelNames) {
          const node = removeNode(srcLoaded.metaTree, name);
          if (node) movedNodes.push(node);
        }

        // ②実ファイル操作（タブ間移動時のみ物理ファイルを移動。同一タブ内はツリー位置のみ変更）。
        // 複数ファイルのバッチ処理中に一部だけ失敗した場合、既に移動済みのファイルは両タブの
        // ディスク上メタにまだ未反映のまま関数を抜ける（movedNodes の変更はメモリ上のみで
        // 破棄される）。次回 tab:openTree の実ファイル突合（reconcile）で、移動済みファイルは
        // 移動先タブの末尾へフラット追加、移動元タブでは参照が失われるだけでメモ本体は失われない
        // （PLAN §5.3「クラッシュ時の隙は復旧カスケードが安全網」と同種の受容済みトレードオフ）。
        if (!sameTab) {
          for (const node of movedNodes) {
            for (const name of collectSubtreeNames(node)) {
              const res = await moveMemoFileToFolder(srcFolder.value, name, destFolder.value);
              if (!res.ok) return res;
              // インデックス経路①（PLAN §5.3）: 物理ファイル移動に合わせて移設する（名前は不変）。
              moveMemoInIndex(args.srcTabId, name, args.destTabId, name, false);
            }
          }
        }

        // reviewer 指摘 M2-R1-02: 'after' は反復順のまま挿入すると選択順が反転するため、
        // orderForBatchInsert で反復順序を補正する（before/child/first/last は順反復のままでよい）。
        for (const node of orderForBatchInsert(movedNodes, args.destPosition)) {
          insertNode(destLoaded.metaTree, node, args.destPosition, args.destAnchorMemoName);
        }

        // ③メタ JSON アトミック保存（直後）。両タブに影響する場合は両方保存。
        await saveTabMeta(destFolder.value, destLoaded.metaTree);
        if (!sameTab) {
          await saveTabMeta(srcFolder.value, srcLoaded.metaTree);
          // タブ間移動のみインデックスへ反映済み（上記ループ内）なので両タブへ通知する。
          // 同一タブ内の移動はツリー位置のみの変更（実ファイル・本文とも不変）でインデックスに
          // 影響しないため通知しない。
          emitIndexUpdated(event, args.destTabId);
          emitIndexUpdated(event, args.srcTabId);
        }
        return ok(undefined);
      }

      // コピー（Ctrl 併用）: 元を残す。名前衝突があるノードのみ「〇〇のコピー」方式で改名する。
      const reservedNames = new Set(destExistingNames);
      const newTopNodes: MetaTreeNode[] = [];
      const allRenames: { from: string; to: string }[] = [];

      for (const name of topLevelNames) {
        const loc = findNode(srcLoaded.metaTree, name);
        if (!loc) continue;
        const cloned = cloneSubtreeWithUniqueNames(structuredClone(loc.node), reservedNames);
        newTopNodes.push(cloned.node);
        allRenames.push(...cloned.renames);
      }

      // ②実ファイル操作: 各ノードをコピー（元は残す）。
      for (const rename of allRenames) {
        const res = await copyMemoFileToFolder(srcFolder.value, rename.from, destFolder.value, rename.to);
        if (!res.ok) return res;
        // インデックス経路①: コピー先エントリを追加する（元エントリはそのまま残す, copy=true）。
        moveMemoInIndex(args.srcTabId, rename.from, args.destTabId, rename.to, true);
      }

      for (const node of orderForBatchInsert(newTopNodes, args.destPosition)) {
        insertNode(destLoaded.metaTree, node, args.destPosition, args.destAnchorMemoName);
      }

      // ③メタ JSON アトミック保存（コピー先のみ。元タブのメタは変更していない）。
      await saveTabMeta(destFolder.value, destLoaded.metaTree);
      emitIndexUpdated(event, args.destTabId);
      return ok(undefined);
    })
  );

  // --- tree:updateStructure（ツリー順序・階層・開閉・ラベルのメタ更新, PLAN §2.2） ---
  ipcMain.handle(
    IpcChannels.tree.updateStructure,
    wrapHandler(async (_event: IpcMainInvokeEvent, args: TreeUpdateStructureArgs): Promise<Result<void>> => {
      const folder = getTabFolderPath(args.tabId);
      if (!folder.ok) return folder;
      const folderPath = folder.value;

      const scanned = await scanTabFolder(folderPath);
      const scannedNames = new Set(scanned.map((s) => s.memoName));

      const flatNames: string[] = [];
      (function flatten(nodes: MetaTreeNode[]): void {
        for (const n of nodes) {
          flatNames.push(n.memoName);
          flatten(n.children);
        }
      })(args.treeStructure);

      const nameSet = new Set(flatNames);
      if (nameSet.size !== flatNames.length) {
        return err('NAME_DUPLICATE', '送信されたツリー構造内にメモ名の重複があります。');
      }
      const setsMatch = nameSet.size === scannedNames.size && [...nameSet].every((n) => scannedNames.has(n));
      if (!setsMatch) {
        return err(
          'NOT_FOUND',
          'ツリー構造が実ファイルと一致しません。画面を再読み込みしてから再度お試しください。',
          folderPath
        );
      }

      await saveTabMeta(folderPath, args.treeStructure);
      return ok(undefined);
    })
  );
}
