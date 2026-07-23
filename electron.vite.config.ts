import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared')
};

/**
 * ビルド時に CSP の `<meta http-equiv="Content-Security-Policy">` を index.html へ注入する。
 *
 * 当初はメインプロセス側 `session.defaultSession.webRequest.onHeadersReceived` で動的付与する
 * 方式を試したが、本番ビルドは `win.loadFile` による `file://` 読み込みのため
 * `webRequest.onHeadersReceived` がレスポンスを傍受せず CSP が一切適用されない（`eval` が
 * ブロックされないことを実機確認済み）ことが判明した。dev（`http://localhost`, Vite dev
 * サーバ）/ prod（`file://`）のどちらでも確実に効く静的 `<meta>` 方式に統一し、
 * 'unsafe-eval' の要否（dev の Vite HMR のみ必要）だけをビルド時に出し分ける。
 */
function cspMetaPlugin(isDev: boolean): Plugin {
  const scriptSrc = isDev ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'";
  const csp = `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; object-src 'none'`;

  return {
    name: 'ttn-csp-meta',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`
      );
    }
  };
}

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      resolve: { alias: sharedAlias }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: { alias: sharedAlias }
    },
    renderer: {
      resolve: { alias: sharedAlias },
      plugins: [react(), cspMetaPlugin(isDev)]
    }
  };
});
