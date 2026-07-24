// src/main/index.ts
// app 起動・BrowserWindow 生成・ライフサイクル（PLAN.md §3）。
// トレイ常駐（最小限: 表示/非表示トグル + 終了, DESIGN §2.7）は M7 で実装する。
import { join } from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { registerIpc } from './ipc/registerIpc';
import { initAppSettings } from './settings/appSettings';
import { listTabs } from './fs/tabService';
import { loadTabMeta } from './fs/metaStore';
import { buildIndex } from './search/searchIndex';
import { startWatching, stopWatching } from './watch/watcher';
import { IpcEvents, type MetaRecoveredPayload } from '@shared/ipc-contract';

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

function createMainWindow(windowState: WindowBounds): BrowserWindow {
  const { x, y, width, height, maximized } = clampWindowBounds(windowState);
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    autoHideMenuBar: true,
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
    win.show();
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
  const { settings } = await initAppSettings();

  registerIpc();
  await buildIndex(listTabs());
  const win = createMainWindow(settings.window);
  mainWindowRef = win;
  tray = createTray();
  startWatching(
    win.webContents,
    listTabs().map((tab) => ({ tabId: tab.id, folderPath: tab.folderPath }))
  );

  win.webContents.once('did-finish-load', () => {
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
      const reactivatedWin = createMainWindow(settings.window);
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

void app.whenReady().then(bootstrap);

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
