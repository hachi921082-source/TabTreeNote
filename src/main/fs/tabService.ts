// src/main/fs/tabService.ts
// フォルダ=タブの登録・作成・走査（直下のみ, リンク無視, PLAN §3）。
// タブの並び順・実体は AppSettings.tabs（配列順が正本, Fix7）に保持する。
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Result, TabInfo, TreeSnapshot } from '@shared/models';
import { err, ok } from '../util/result';
import { isLongPath, normalizeForCompare, validateExistingName, validateName } from './pathSafety';
import { getAppSettings, updateAppSettings } from '../settings/appSettings';
import { defaultTabsRootDir } from './appDataRoot';
import { loadTabMeta, type LoadedMeta } from './metaStore';
import { registerSelfWrite } from '../watch/selfWriteRegistry';
import { withRetry } from './retry';
import { trashPath } from './trash';

async function folderExists(folderPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(folderPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function isDuplicateTabName(name: string, existing: readonly { name: string }[]): boolean {
  const normalized = normalizeForCompare(name);
  return existing.some((t) => normalizeForCompare(t.name) === normalized);
}

function isDuplicateFolderPath(folderPath: string, existing: readonly { folderPath: string }[]): boolean {
  const resolved = resolve(folderPath);
  return existing.some((t) => resolve(t.folderPath) === resolved);
}

/** 登録タブ一覧を取得する（アプリ設定の登録順, `tab:list`）。 */
export function listTabs(): TabInfo[] {
  return getAppSettings().tabs.map((t) => ({ id: t.id, name: t.name, folderPath: t.folderPath }));
}

/** tabId からタブフォルダの絶対パスを解決する。 */
export function getTabFolderPath(tabId: string): Result<string> {
  const tab = getAppSettings().tabs.find((t) => t.id === tabId);
  if (!tab) return err('NOT_FOUND', `タブが見つかりません: ${tabId}`);
  return ok(tab.folderPath);
}

/** 既存フォルダをタブ登録する（`tab:register`）。表示名は folder のベース名から自動導出。 */
export async function registerTab(folderPathRaw: string): Promise<Result<TabInfo>> {
  const folderPath = resolve(folderPathRaw);

  if (isLongPath(folderPath)) {
    return err('LONG_PATH', `パスが長すぎます（260文字超）: ${folderPath}`, folderPath);
  }
  if (!(await folderExists(folderPath))) {
    return err('NOT_FOUND', `フォルダが見つかりません: ${folderPath}`, folderPath);
  }

  const name = basename(folderPath);
  // 登録対象は既に実在するフォルダであり新規作成ではないため、前後空白等を理由に登録自体を
  // 拒否しない（ユーザー報告バグ: フォルダ名に前後空白があると登録できない事象の確認・修正）。
  // `validateName` の厳格な規則は `createTab`/`renameTab` の新規命名時のみ課す。
  const nameCheck = validateExistingName(name);
  if (!nameCheck.ok) return nameCheck;

  const settings = getAppSettings();
  if (isDuplicateFolderPath(folderPath, settings.tabs)) {
    return err('NAME_DUPLICATE', `既に登録済みのフォルダです: ${folderPath}`, folderPath);
  }
  if (isDuplicateTabName(name, settings.tabs)) {
    return err('NAME_DUPLICATE', `タブ名が重複しています: ${name}`);
  }

  const tab = { id: randomUUID(), name, folderPath };
  await updateAppSettings((draft) => {
    draft.tabs.push(tab);
  });
  return ok(tab);
}

/**
 * 新規フォルダを作成しタブ登録する（`tab:create`）。名前サニタイズ+重複拒否。
 * `parentDirRaw` 省略時はポータブル性を優先し、アプリ本体直下の `data` フォルダ
 * （[[appDataRoot.ts]] `defaultTabsRootDir`）を既定の作成先として自動生成する（developer 判断）。
 */
export async function createTab(parentDirRaw: string | undefined, name: string): Promise<Result<TabInfo>> {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return nameCheck;

  const resolvedParent = resolve(parentDirRaw ?? defaultTabsRootDir());
  if (!parentDirRaw) {
    await fs.mkdir(resolvedParent, { recursive: true });
  }
  if (!(await folderExists(resolvedParent))) {
    return err('NOT_FOUND', `親フォルダが見つかりません: ${resolvedParent}`, resolvedParent);
  }

  const folderPath = resolve(resolvedParent, name);
  if (isLongPath(folderPath)) {
    return err('LONG_PATH', `パスが長すぎます（260文字超）: ${folderPath}`, folderPath);
  }
  if (await folderExists(folderPath)) {
    return err('NAME_DUPLICATE', `同名のフォルダが既に存在します: ${folderPath}`, folderPath);
  }

  const settings = getAppSettings();
  if (isDuplicateTabName(name, settings.tabs)) {
    return err('NAME_DUPLICATE', `タブ名が重複しています: ${name}`);
  }

  await fs.mkdir(folderPath, { recursive: false });

  const tab = { id: randomUUID(), name, folderPath };
  await updateAppSettings((draft) => {
    draft.tabs.push(tab);
  });
  return ok(tab);
}

/** タブのツリー（メタ+実ファイル突合結果）を取得する（`tab:openTree`）。 */
export async function openTabTree(
  tabId: string,
  onRecovered?: (message: string) => void
): Promise<Result<TreeSnapshot>> {
  const folderResult = getTabFolderPath(tabId);
  if (!folderResult.ok) return folderResult;

  const loaded: LoadedMeta = await loadTabMeta(folderResult.value);
  if (loaded.recovered && loaded.recoveredMessage && onRecovered) {
    onRecovered(loaded.recoveredMessage);
  }
  return ok({ tabId, tree: loaded.tree });
}

// ---------------------------------------------------------------------------
// M2: tab:rename / tab:remove / tab:reorder（PLAN §2.1、docs/milestones/M2-tree-ui.md）
// ---------------------------------------------------------------------------

/**
 * タブをリネームする（＝タブフォルダをリネーム, DESIGN §2.1）。同期順序（00-core-principles.md
 * §3）に従う: ①重複チェック・サニタイズ先行 → ②`fs.rename`（自己書き込み予約込み） →
 * ③アプリ設定 JSON をアトミック保存（タブの `folderPath`/`name` を更新）。
 */
export async function renameTab(tabId: string, newNameRaw: string): Promise<Result<void>> {
  const nameCheck = validateName(newNameRaw);
  if (!nameCheck.ok) return nameCheck;

  const settings = getAppSettings();
  const tab = settings.tabs.find((t) => t.id === tabId);
  if (!tab) return err('NOT_FOUND', `タブが見つかりません: ${tabId}`);
  if (tab.name === newNameRaw) return ok(undefined);

  const others = settings.tabs.filter((t) => t.id !== tabId);
  if (isDuplicateTabName(newNameRaw, others)) {
    return err('NAME_DUPLICATE', `タブ名が重複しています: ${newNameRaw}`);
  }

  const newFolderPath = resolve(dirname(tab.folderPath), newNameRaw);
  if (isLongPath(newFolderPath)) {
    return err('LONG_PATH', `パスが長すぎます（260文字超）: ${newFolderPath}`, newFolderPath);
  }
  if (await folderExists(newFolderPath)) {
    return err('NAME_DUPLICATE', `同名のフォルダが既に存在します: ${newFolderPath}`, newFolderPath);
  }

  registerSelfWrite(tab.folderPath);
  registerSelfWrite(newFolderPath);
  await withRetry(() => fs.rename(tab.folderPath, newFolderPath));

  await updateAppSettings((draft) => {
    const t = draft.tabs.find((x) => x.id === tabId);
    if (t) {
      t.name = newNameRaw;
      t.folderPath = newFolderPath;
    }
  });
  return ok(undefined);
}

/**
 * タブ登録を解除する（既定はフォルダ削除しない）。`deleteFolder:true` 指定時はごみ箱送りを
 * 試み、失敗時は `TRASH_FAILED` を返しタブ登録は解除しない（フォルダ・登録とも変更なしのまま
 * ユーザーが再試行できる）。ごみ箱送り成功後、またはフォルダ削除なしの場合にタブ登録を解除する。
 */
export async function removeTab(tabId: string, deleteFolder: boolean): Promise<Result<void>> {
  const settings = getAppSettings();
  const tab = settings.tabs.find((t) => t.id === tabId);
  if (!tab) return err('NOT_FOUND', `タブが見つかりません: ${tabId}`);

  if (deleteFolder) {
    const trashResult = await trashPath(tab.folderPath);
    if (!trashResult.ok) return trashResult;
  }

  await updateAppSettings((draft) => {
    draft.tabs = draft.tabs.filter((t) => t.id !== tabId);
  });
  return ok(undefined);
}

/** タブを並べ替える（`orderedTabIds` の順に `AppSettings.tabs` 配列自体を並べ替える, Fix7）。 */
export async function reorderTabs(orderedTabIds: string[]): Promise<Result<void>> {
  const settings = getAppSettings();
  const currentIds = new Set(settings.tabs.map((t) => t.id));
  const newIds = new Set(orderedTabIds);
  const sameSet = currentIds.size === newIds.size && [...currentIds].every((id) => newIds.has(id));
  if (!sameSet) {
    return err('NAME_INVALID', 'タブの並べ替え対象が現在の登録タブ一覧と一致しません。');
  }

  const byId = new Map(settings.tabs.map((t) => [t.id, t] as const));
  const reordered = orderedTabIds.map((id) => byId.get(id)).filter((t): t is (typeof settings.tabs)[number] => t !== undefined);

  await updateAppSettings((draft) => {
    draft.tabs = reordered;
  });
  return ok(undefined);
}
