// src/main/ipc/linkHandlers.ts
// リンク機能の IPC ハンドラ（PLAN §2.5 / DESIGN §2.8 / docs/milestones/M5-links.md）。
//
// - link:openExternal: URL/mailto/ファイルパスの外部起動。相対パスは baseTabId の
//   タブフォルダ絶対パス基準で `path.resolve` してから `shell.openPath`/`shell.openExternal`
//   へ渡す（実装上の必須事項, DESIGN §2.8: 相対パス文字列をそのまま shell.openPath に渡すと
//   OS がアプリ実行ファイルの場所からの相対と解釈するバグになるため、必ず絶対パス化する）。
//   シェル文字列連結は一切行わない（OS コマンドインジェクション回避, 00-core-principles.md §10）。
// - link:resolveMemo: `memo:` 記法の解決。解決不能時は null（エラーダイアログを出さない,
//   DESIGN §2.8）。
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { IpcChannels } from '@shared/ipc-contract';
import { LINK_OPEN_PATH_TIMEOUT_MS } from '@shared/constants';
import type { LinkOpenExternalArgs, LinkResolveMemoArgs, LinkResolveMemoResult } from '@shared/ipc-contract';
import type { Result } from '@shared/models';
import { err, ok, wrapHandler } from '../util/result';
import { findMemoFile } from '../fs/memoFileService';
import { normalizeForCompare, validateName } from '../fs/pathSafety';
import { getTabFolderPath, listTabs } from '../fs/tabService';

/**
 * URL として外部起動を許可するスキーム（main/index.ts の `setWindowOpenHandler` と同じ
 * 許可リスト方針, M0-R1-02 対応の踏襲）。`mailto:` は専用チェックで扱う。
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'ftp:']);

/** URL のスキーム（例 `https:`）を安全に取り出す。パース不能な文字列は null。 */
function safeUrlScheme(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/**
 * `file://` プレフィックスをローカルファイルパス文字列へ正規化する。
 * それ以外（`C:\...`, `.\...`, `..\...` 等）はそのまま返す。
 */
function normalizeFilePathRaw(raw: string): string {
  if (!raw.toLowerCase().startsWith('file://')) return raw;
  try {
    const url = new URL(raw);
    // file:///C:/foo/bar → pathname は "/C:/foo/bar"。先頭のスラッシュ+ドライブレターを除去する。
    return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch {
    return raw;
  }
}

/** `withTimeout` の判別結果。 */
type RaceResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * `promise` を `ms` ミリ秒でタイムアウト付きに待つ。タイムアウトしても元の Promise 自体は
 * キャンセルできない（`shell.openPath` 等 OS API 呼び出しはキャンセル不能なため）が、呼び出し元
 * には即座にタイムアウトを通知できる（tester検証M5: 対象ファイル不在パスで shell.openPath が
 * 無期限に応答しない事象への安全網）。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceResult<T>> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise({ timedOut: true }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise({ timedOut: false, value });
      },
      () => {
        // shell.openPath は例外を投げない仕様（失敗時は文字列を返す）だが、念のため reject
        // されてもタイムアウト同様に扱う（呼び出し元は UNKNOWN として丸める）。
        clearTimeout(timer);
        resolvePromise({ timedOut: true });
      }
    );
  });
}

async function openExternalLink(args: LinkOpenExternalArgs): Promise<Result<void>> {
  const { kind, raw } = args;

  if (kind === 'url') {
    // `www.` 始まりはスキーム省略のため https を補ってから検証する（DESIGN §2.8「www. で開始」）。
    const normalizedUrl = /^www\./i.test(raw) ? `https://${raw}` : raw;
    const scheme = safeUrlScheme(normalizedUrl);
    if (!scheme || !ALLOWED_URL_SCHEMES.has(scheme)) {
      return err('NAME_INVALID', `許可されていないURLです: ${raw}`);
    }
    await shell.openExternal(normalizedUrl);
    return ok(undefined);
  }

  if (kind === 'mailto') {
    // 素のメールアドレスにも mailto: を補ってから検証する（DESIGN §2.8「mailto: 前置も可」）。
    const normalizedMail = raw.toLowerCase().startsWith('mailto:') ? raw : `mailto:${raw}`;
    if (safeUrlScheme(normalizedMail) !== 'mailto:') {
      return err('NAME_INVALID', `不正なメールリンクです: ${raw}`);
    }
    await shell.openExternal(normalizedMail);
    return ok(undefined);
  }

  // kind === 'path'
  const filePathRaw = normalizeFilePathRaw(raw);
  let absolutePath: string;
  if (isAbsolute(filePathRaw)) {
    absolutePath = filePathRaw;
  } else {
    if (!args.baseTabId) {
      return err('NAME_INVALID', '相対パスの解決に必要な baseTabId が指定されていません。');
    }
    const folderResult = getTabFolderPath(args.baseTabId);
    if (!folderResult.ok) return folderResult;
    // 必須事項（DESIGN §2.8）: 相対パスは必ず管理フォルダの絶対パス基準で path.resolve してから
    // shell.openPath へ渡す（そのまま渡すと OS がアプリ実行ファイル基準と解釈するバグになる）。
    absolutePath = resolve(folderResult.value, filePathRaw);
  }

  // 事前存在チェック（tester検証M5対応）: 親フォルダは実在するが対象自体が存在しないパスを
  // shell.openPath に渡すと、この環境では Windows 側のファイル種別解決処理起因と見られる
  // 無期限ハングが発生することを確認した。shell.openPath を呼ぶ前に存在確認することで、
  // 大半のケース（対象不在）を即座に NOT_FOUND として返せるようにする。
  try {
    await access(absolutePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return err('NOT_FOUND', `ファイルが見つかりません: ${absolutePath}`, absolutePath);
    }
    // ENOENT 以外（権限エラー等）は事前チェックで確定的に弾かず、shell.openPath 自体の
    // 判断（+下記タイムアウト安全網）に委ねる。
  }

  // shell.openPath はファイル/フォルダいずれも関連付けアプリ（フォルダはエクスプローラ）で開く。
  // 失敗時は空文字以外のエラーメッセージ文字列を返す仕様（例外は投げない）。
  // 事前チェックをすり抜けるレース（チェック直後に対象が削除される等）や、その他の環境依存の
  // 遅延に備え、呼び出し自体にもタイムアウトを設けて無期限ハングを防ぐ（tester検証M5対応）。
  const raceResult = await withTimeout(shell.openPath(absolutePath), LINK_OPEN_PATH_TIMEOUT_MS);
  if (raceResult.timedOut) {
    // eslint-disable-next-line no-console -- 内部診断ログ（レンダラへはcode/messageのみ返す, §10）
    console.error('[main] shell.openPath timed out', { path: absolutePath, timeoutMs: LINK_OPEN_PATH_TIMEOUT_MS });
    return err('UNKNOWN', `応答がありませんでした（タイムアウト）: ${absolutePath}`, absolutePath);
  }
  const openError = raceResult.value;
  if (openError) {
    return err('NOT_FOUND', `開けませんでした: ${openError}`, absolutePath);
  }
  return ok(undefined);
}

/**
 * `memo:` 記法を解決する（DESIGN §2.8）。区切りは `/` または `\`。
 * - `memo:メモ名` … 現在タブ内の該当メモ。
 * - `memo:タブ名/メモ名` … 指定タブの指定メモ。
 * - `memo:タブ名/` … 指定タブを開く（メモ指定なし）。
 * 解決不能（タブ/メモ未検出、不正な名前）は例外的な UI エラーにせず null を返す。
 */
async function resolveMemoLink(args: LinkResolveMemoArgs): Promise<Result<LinkResolveMemoResult | null>> {
  const ref = args.memoRef.trim();
  if (!ref) return ok(null);

  const normalized = ref.replace(/\\/g, '/');
  const slashIndex = normalized.indexOf('/');

  let targetTabId: string;
  let memoName: string | undefined;

  if (slashIndex === -1) {
    targetTabId = args.currentTabId;
    memoName = normalized;
  } else {
    const tabPart = normalized.slice(0, slashIndex);
    const memoPart = normalized.slice(slashIndex + 1);
    const tab = listTabs().find((t) => normalizeForCompare(t.name) === normalizeForCompare(tabPart));
    if (!tab) return ok(null); // タブ名一致なし → 解決不能（エラーにしない）
    targetTabId = tab.id;
    memoName = memoPart.length > 0 ? memoPart : undefined;
  }

  const folder = getTabFolderPath(targetTabId);
  if (!folder.ok) return ok(null);

  if (memoName === undefined) {
    // memo:タブ名/ … タブの実在のみ確認済みなのでそのまま返す。
    return ok({ tabId: targetTabId });
  }

  // メモ名はサニタイズ規則上 `/`/`\` 等を含み得ない（validateName, 00-core-principles.md §11）。
  // 万一含む場合（悪意ある/破損した本文由来）は解決不能扱いとし、フォルダ閉じ込め外の
  // パスへ `findMemoFile` の join が到達すること自体を未然に防ぐ（多層防御）。
  if (!validateName(memoName).ok) return ok(null);

  const found = await findMemoFile(folder.value, memoName);
  if (!found) return ok(null); // 実ファイル未検出 → 解決不能（エラーダイアログは出さない）
  return ok({ tabId: targetTabId, memoName });
}

export function registerLinkHandlers(): void {
  ipcMain.handle(
    IpcChannels.link.openExternal,
    wrapHandler((_event: IpcMainInvokeEvent, args: LinkOpenExternalArgs): Promise<Result<void>> => openExternalLink(args))
  );

  ipcMain.handle(
    IpcChannels.link.resolveMemo,
    wrapHandler(
      (_event: IpcMainInvokeEvent, args: LinkResolveMemoArgs): Promise<Result<LinkResolveMemoResult | null>> =>
        resolveMemoLink(args)
    )
  );
}
