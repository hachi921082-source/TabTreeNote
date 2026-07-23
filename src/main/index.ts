// src/main/index.ts
// app 起動・BrowserWindow 生成・ライフサイクル（PLAN.md §3）。
// トレイ常駐は M7 で本格化する（M0 では未実装）。
import { join } from 'node:path';
import { app, BrowserWindow, screen, shell } from 'electron';
import { registerIpc } from './ipc/registerIpc';
import { initAppSettings } from './settings/appSettings';
import { listTabs } from './fs/tabService';
import { loadTabMeta } from './fs/metaStore';
import { buildIndex } from './search/searchIndex';
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

  // 外部リンクは既定ブラウザで開く。BrowserWindow 内でナビゲートさせない。
  // スキーム許可リストで検証してから shell.openExternal へ委譲する（reviewer 指摘 M0-R1-02。
  // 本格的なリンク確認ダイアログ・path.resolve 等の安全化は M5 で実装, DESIGN §2.8）。
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
 */
async function bootstrap(): Promise<void> {
  const { settings } = await initAppSettings();

  registerIpc();
  await buildIndex(listTabs());
  const win = createMainWindow(settings.window);

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
      createMainWindow(settings.window);
    }
  });
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
