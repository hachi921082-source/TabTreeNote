// src/main/index.ts
// app 起動・BrowserWindow 生成・ライフサイクル（PLAN.md §3）。
// トレイ常駐（最小限: 表示/非表示トグル + 終了, DESIGN §2.7）は M7 で実装する。
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { registerIpc } from './ipc/registerIpc';
import { initAppSettings } from './settings/appSettings';
import { portableUserDataDir } from './fs/appDataRoot';
import { listTabs } from './fs/tabService';
import { loadTabMeta } from './fs/metaStore';
import { buildIndex } from './search/searchIndex';
import { startWatching, stopWatching } from './watch/watcher';
import { getActiveMemoState } from './watch/activeMemoState';
import {
  IpcEvents,
  type EditorMenuCommandPayload,
  type MetaRecoveredPayload,
  type ShowPropertiesPayload
} from '@shared/ipc-contract';

// 設定/タブ登録の保存先をアプリ本体直下（`data` と同じ基準）へ切り替える（ユーザー要望）。
// これにより exe をフォルダごとコピーするだけで完全に独立したプロファイル（設定もタブ登録も
// 別々、多重起動ロックもコピー単位）になる。Electron の既定 userData（%APPDATA%\tabtreenote）
// が使われるより前、`app.getPath`/`requestSingleInstanceLock` 呼び出しより前に行うこと。
const legacyUserDataDir = app.getPath('userData');
app.setPath('userData', portableUserDataDir());

/**
 * 既定（%APPDATA%）に既存の設定があり、新しい保存先（exe直下の `config`）にまだ無い場合に
 * 1回だけコピーする（ユーザーが以前のバージョンから引き続き使う際に、登録済みタブや好みの
 * 設定を失わないための移行措置。元ファイルは削除しない）。
 */
async function migrateLegacySettingsIfNeeded(): Promise<void> {
  const newDir = app.getPath('userData');
  const fileName = 'app-settings.json';
  const newPath = join(newDir, fileName);
  const legacyPath = join(legacyUserDataDir, fileName);
  if (newDir === legacyUserDataDir) return; // 実質的に旧設定と同じ場所（開発時等）。

  const newExists = await fs.access(newPath).then(() => true).catch(() => false);
  if (newExists) return;
  const legacyExists = await fs.access(legacyPath).then(() => true).catch(() => false);
  if (!legacyExists) return;

  await fs.mkdir(newDir, { recursive: true });
  await fs.copyFile(legacyPath, newPath);
  const legacyBak = `${legacyPath}.bak`;
  if (await fs.access(legacyBak).then(() => true).catch(() => false)) {
    await fs.copyFile(legacyBak, `${newPath}.bak`).catch(() => undefined);
  }
}

/** 外部起動を許可する URL スキーム（reviewer 指摘 M0-R1-02）。それ以外は無視して開かない。 */
const ALLOWED_EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** URL のスキーム（例 `https:`）を安全に取り出す。パース不能な文字列は null。 */
function safeUrlScheme(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

// CSP は electron.vite.config.ts の cspMetaPlugin が index.html に静的 <meta> として注入する
// （reviewer 指摘 M0-R1-01 対応。当初 session.webRequest.onHeadersReceived で動的付与を試みたが、
// 本番ビルドの file:// 読み込みではヘッダが傍受されず CSP が無効化されることを実機確認したため、
// dev/prod どちらの読み込み方式でも確実に効く静的 meta 方式に変更した）。

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

// --- タスクトレイ常駐（最小限, M7 / DESIGN §2.7）---------------------------------------------
// 「終了」メニュー/`app.quit()` 経由でのみ実際に終了する。ウィンドウの×ボタンはトレイへ
// 最小化するだけにする（`win.on('close', ...)` で preventDefault し hide() する、下記参照）。
let tray: Tray | null = null;
let mainWindowRef: BrowserWindow | null = null;
let isQuitting = false;

/**
 * トレイアイコン用の小さな単色ビットマップを生成する。本リポジトリには専用の .ico/.png
 * アセットが無い（v1 では未作成、developer 判断でスコープ外）ため、外部アセットファイルに
 * 依存せず自己完結する形で `nativeImage.createFromBuffer` 用の生 BGRA バッファを組み立てる
 * （Electron の nativeImage 生バッファ形式は BGRA, 4 bytes/px）。将来 `build/icon.ico` 等の
 * 正式アセットを用意したら `nativeImage.createFromPath` に差し替えてよい。
 */
function buildTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    buffer[o] = 0xd0; // B
    buffer[o + 1] = 0x7a; // G
    buffer[o + 2] = 0x4a; // R（TabTreeNote既定アクセントカラーに寄せた単色, theme.css参照）
    buffer[o + 3] = 0xff; // A
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function toggleMainWindowVisibility(): void {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

function createTray(): Tray {
  const t = new Tray(buildTrayIcon());
  t.setToolTip('TabTreeNote');
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: '表示/非表示', click: () => toggleMainWindowVisibility() },
      { type: 'separator' },
      {
        label: '終了',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  // シングルクリックでも表示/非表示をトグルする（Windows の通知領域アイコンの慣習, DESIGN §2.7）。
  t.on('click', () => toggleMainWindowVisibility());
  return t;
}

/** 保存済みウィンドウ位置がプライマリディスプレイの作業領域と全く重ならない場合は既定値へフォールバックする。 */
function clampWindowBounds(bounds: WindowBounds): WindowBounds {
  const work = screen.getPrimaryDisplay().workArea;
  const overlaps = bounds.x < work.x + work.width && bounds.x + bounds.width > work.x &&
    bounds.y < work.y + work.height && bounds.y + bounds.height > work.y;
  return overlaps ? bounds : { ...bounds, x: work.x + 50, y: work.y + 50 };
}

/**
 * Windowsログイン時の自動起動（ユーザー要望）から起動されたかどうか。`windowHandlers.ts`の
 * `window:setOpenAtLogin`がスタートアップ登録に付与する`--hidden`引数で判定する
 * （`app.getLoginItemSettings().wasOpenedAtLogin`はカスタム`path`/`args`登録では
 * 挙動が環境依存になりやすいため、確実な自前フラグを使う, developer 判断）。
 */
const startedHidden = process.argv.includes('--hidden');

// ウィンドウ左上（タイトルバー/タスクバー）のアイコン（ユーザー要望）。ビルド後の実行ファイル
// アイコン（electron-builder.yml の win.icon, icon02.png）とは別素材を使う指定のため、
// BrowserWindow 個別に指定する。`files` にプロジェクト直下の icon01.png を含めているため、
// `app.getAppPath()`（開発時=プロジェクト直下、パッケージ後=app.asar 直下）から解決できる。
const WINDOW_ICON_PATH = join(app.getAppPath(), 'icon01.png');

function createMainWindow(windowState: WindowBounds, startHidden: boolean): BrowserWindow {
  const { x, y, width, height, maximized } = clampWindowBounds(windowState);
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    autoHideMenuBar: true,
    icon: WINDOW_ICON_PATH,
    webPreferences: {
      // セキュリティ不変条件（docs/00-core-principles.md §10）: 必ず設定すること。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js')
    }
  });

  if (maximized) {
    win.maximize();
  }

  win.once('ready-to-show', () => {
    // 自動起動時はトレイに隠れた状態で待機させる（ユーザー要望: 起動の遅さを回避するため、
    // ログイン時に1回だけ裏で起動しておき、以降はトレイアイコンから即座に開く運用）。
    if (!startHidden) win.show();
  });

  // トレイ常駐（最小限, M7 / DESIGN §2.7）: ×ボタンでは終了せずトレイへ最小化するだけにする。
  // 実際の終了はトレイメニュー「終了」（`isQuitting=true` → `app.quit()`）経由のみ。
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // 外部リンクは既定ブラウザで開く。BrowserWindow 内でナビゲートさせない。
  // スキーム許可リストで検証してから shell.openExternal へ委譲する（reviewer 指摘 M0-R1-02）。
  // 本文中のリンク（URL/mail/path/memo:）のクリック→確認ダイアログ→外部起動/遷移は
  // ipc/linkHandlers.ts（link:openExternal/link:resolveMemo）が本流を担う（M5, DESIGN §2.8）。
  // 本ハンドラは `window.open()`/`target=_blank` 等の一般的なナビゲーション要求に対する
  // 最終防御（保険）として引き続き残す（本アプリの CodeMirror リンク装飾は実アンカー要素を
  // 生成しないため、通常はこの経路を通らない）。
  win.webContents.setWindowOpenHandler(({ url }) => {
    const scheme = safeUrlScheme(url);
    if (scheme && ALLOWED_EXTERNAL_URL_SCHEMES.has(scheme)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // エディタ本文の右クリックメニュー（ユーザー要望: 標準編集操作+文字種変換+チェック+書式
  // ショートカット+Google検索+プロパティ）。Electron は `context-menu` を明示的にハンドルしない
  // 限りネイティブメニューを出さないため、必要な項目を自前で組み立てる。
  // CodeMirror の Undo履歴・選択範囲操作（元に戻す/変換/チェック等）はネイティブの role では
  // CodeMirror の内部状態と同期しない（壊れる）ため、`evt:editorMenuCommand` でレンダラへ
  // 実行を委譲する（editor/textCommands.ts 参照）。
  win.webContents.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    const hasSelection = params.selectionText.length > 0;
    // 現在開いているメモは レンダラが editor:reportActive で通知した activeMemoState から把握
    // する（M4 で既存の仕組み）。メモが開かれていない場合は編集系項目を一切出さない。
    const active = getActiveMemoState();
    const send = (payload: EditorMenuCommandPayload): void => win.webContents.send(IpcEvents.editorMenuCommand, payload);

    if (params.isEditable) {
      items.push(
        { label: '切り取り', role: 'cut', enabled: hasSelection },
        { label: 'コピー', role: 'copy', enabled: hasSelection },
        { label: '貼り付け', role: 'paste' },
        { label: 'すべて選択', role: 'selectAll' }
      );
    } else if (hasSelection) {
      items.push({ label: 'コピー', role: 'copy' });
    }

    if (active) {
      if (items.length > 0) items.push({ type: 'separator' });
      items.push(
        { label: '元に戻す', click: () => send({ kind: 'textCommand', command: 'undo' }) },
        { label: 'やり直し', click: () => send({ kind: 'textCommand', command: 'redo' }) },
        { label: '削除', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'deleteSelection' }) },
        {
          label: '変換',
          submenu: [
            { label: '大文字/小文字の反転', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'invertCase' }) },
            { label: '大文字に変換', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'toUpperCase' }) },
            { label: '小文字に変換', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'toLowerCase' }) },
            { type: 'separator' },
            { label: 'ひらがなに変換', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'toHiragana' }) },
            { label: 'カタカナに変換', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'toKatakana' }) },
            { type: 'separator' },
            { label: '半角に変換', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'toHalfWidth' }) },
            { label: '全角に変換', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'toFullWidth' }) },
            { type: 'separator' },
            { label: 'タブをスペースに変換', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'tabsToSpaces' }) },
            { label: 'スペースをタブに変換', enabled: hasSelection, click: () => send({ kind: 'textCommand', command: 'spacesToTabs' }) }
          ]
        },
        { label: 'チェック', click: () => send({ kind: 'textCommand', command: 'toggleCheckbox' }) },
        {
          label: '書式',
          submenu: [
            { label: '折り返さない', click: () => send({ kind: 'setWrap', wrap: 'none' }) },
            { label: '指定文字数で折り返し', click: () => send({ kind: 'setWrap', wrap: 'chars' }) },
            { label: 'ウィンドウ幅で折り返し', click: () => send({ kind: 'setWrap', wrap: 'window' }) },
            { type: 'separator' },
            { label: '行番号表示を切替', click: () => send({ kind: 'toggleLineNumbers' }) },
            { label: '空白・改行の表示を切替', click: () => send({ kind: 'toggleWhitespace' }) },
            { type: 'separator' },
            { label: 'フォントサイズを拡大', click: () => send({ kind: 'fontSize', action: 'increase' }) },
            { label: 'フォントサイズを縮小', click: () => send({ kind: 'fontSize', action: 'decrease' }) },
            { label: 'フォントサイズをリセット', click: () => send({ kind: 'fontSize', action: 'reset' }) }
          ]
        }
      );
    }

    if (hasSelection) {
      if (items.length > 0) items.push({ type: 'separator' });
      const query = params.selectionText.length > 40 ? `${params.selectionText.slice(0, 40)}…` : params.selectionText;
      items.push({
        label: `Google で検索: 「${query}」`,
        click: () => {
          void shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`);
        }
      });
    }

    if (active) {
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({
        label: 'プロパティ',
        click: () => {
          const payload: ShowPropertiesPayload = { tabId: active.tabId, memoName: active.memoName };
          win.webContents.send(IpcEvents.showProperties, payload);
        }
      });
    }

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

/**
 * 起動時初期化（M1 で扱う範囲, docs/milestones/M1-file-core.md「起動時初期化」。
 * M3 で全文検索インデックス構築を追加, PLAN §5.1 step4）。
 * 1. アプリ設定 JSON 読込（破損時は復旧カスケード、無ければ既定生成）。
 * 2. 全文検索インデックス構築（`searchIndex.buildIndex`）: 登録済み全タブを走査し、
 *    `.txt` はメモ名＋本文、`.txtenc` はメモ名のみをインデックスへ（本文は常に除外, DESIGN §2.4）。
 *    DESIGN §4 の想定規模（数百〜数千メモ）ではウィンドウ表示前のブロッキング構築でも許容範囲
 *    （Fix11）。将来規模拡大時にバックグラウンド化しやすいよう、構築処理自体は
 *    `searchIndex.buildIndex` へ分離してある。
 * 3. ウィンドウ復元（位置/サイズ/最大化。テーマ/ツリー幅はレンダラが settings:get で取得する）。
 * 4. 登録タブ一覧を取得し、各タブフォルダについて metaStore.load を先行実行して
 *    メタ破損があれば早期に `evt:metaRecovered` で通知する（実際の表示は tab:openTree 時にも取得）。
 * 5. ファイル監視を開始する（`watcher.startWatching`。登録タブフォルダを対象, PLAN §5.1 step5 /
 *    docs/milestones/M4-watch.md）。
 */
async function bootstrap(): Promise<void> {
  await migrateLegacySettingsIfNeeded();
  const { settings, recovered, recoveredMessage } = await initAppSettings();

  registerIpc();
  await buildIndex(listTabs());
  const win = createMainWindow(settings.window, startedHidden);
  mainWindowRef = win;
  tray = createTray();
  startWatching(
    win.webContents,
    listTabs().map((tab) => ({ tabId: tab.id, folderPath: tab.folderPath }))
  );

  win.webContents.once('did-finish-load', () => {
    // アプリ設定 JSON 自体の復旧（バグ調査で判明した抜け: これまで recovered/recoveredMessage を
    // 握りつぶしており、設定が壊れて既定値へ再生成されてもユーザーに一切通知されなかった。
    // 既存の evt:metaRecovered をそのまま使い回す（tabId 省略でアプリ全体の通知として扱う）。
    if (recovered && recoveredMessage) {
      const payload: MetaRecoveredPayload = { message: recoveredMessage };
      win.webContents.send(IpcEvents.metaRecovered, payload);
    }
    void Promise.all(
      listTabs().map(async (tab) => {
        const loaded = await loadTabMeta(tab.folderPath).catch(() => null);
        if (loaded?.recovered && loaded.recoveredMessage) {
          const payload: MetaRecoveredPayload = { message: loaded.recoveredMessage, tabId: tab.id };
          win.webContents.send(IpcEvents.metaRecovered, payload);
        }
      })
    );
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const reactivatedWin = createMainWindow(settings.window, false);
      mainWindowRef = reactivatedWin;
      if (!tray) tray = createTray();
      startWatching(
        reactivatedWin.webContents,
        listTabs().map((tab) => ({ tabId: tab.id, folderPath: tab.folderPath }))
      );
    } else {
      toggleMainWindowVisibility();
    }
  });
}

// 多重起動防止（ユーザー指摘: 同一の app-settings.json/タブフォルダのメタJSONへ複数プロセスが
// 同時に書き込むと後勝ちで設定/メタが競合破壊されうる。ロック取得に失敗した2個目以降のプロセスは
// 何も初期化せず即終了し、既存プロセス側は `second-instance` で自ウィンドウを前面表示する）。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindowRef;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  void app.whenReady().then(bootstrap);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // トレイ「終了」以外の終了経路（Windows ログオフ等の OS 主導終了を含む）でもここを通るため、
  // ×ボタンでの hide() を抑止する `isQuitting` を最終防御として必ず立てておく。
  isQuitting = true;
  void stopWatching();
});

app.on('will-quit', () => {
  tray?.destroy();
  tray = null;
});
