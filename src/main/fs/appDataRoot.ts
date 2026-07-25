// src/main/fs/appDataRoot.ts
// アプリ本体（実行ファイル/プロジェクトルート）を基準にした各種フォルダの解決（developer 判断、
// ユーザー要望によるポータブル性優先。設定/メモが exe と一体で持ち運べ、コピーごとに独立した
// プロファイルとして動く）。
// ポータブル配布（electron-builder `win.target: portable`）は実行時に exe を一時フォルダへ
// 展開するため `app.getPath('exe')` はその一時パスになる。実体（USB 等）の場所は
// electron-builder が設定する `PORTABLE_EXECUTABLE_DIR` から得る必要がある。
import { app } from 'electron';
import { dirname, join } from 'node:path';

/** ポータブル本体（配布exe/開発時はプロジェクトルート）の場所。 */
export function getPortableBaseDir(): string {
  return app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe'))) : app.getAppPath();
}

/** 新規タブ（フォルダ）の既定作成先。アプリ本体直下の `data` フォルダの絶対パス。 */
export function defaultTabsRootDir(): string {
  return join(getPortableBaseDir(), 'data');
}

/**
 * アプリ設定（`app-settings.json` 等）の保存先。アプリ本体直下の `config` フォルダの絶対パス。
 * `main/index.ts` が起動直後に `app.setPath('userData', ...)` へこの値を渡すことで、
 * exeコピーごとに設定・タブ登録・多重起動ロックが完全に独立したプロファイルになる
 * （ユーザー要望: 複数コピーを同時起動できるようにしたい）。
 */
export function portableUserDataDir(): string {
  return join(getPortableBaseDir(), 'config');
}

/**
 * Windowsログイン時自動起動（`app.setLoginItemSettings`）に登録すべき実行ファイルパス
 * （ユーザー要望）。ポータブル版は起動のたびに `process.execPath` が `%TEMP%` 配下の
 * 使い捨て展開先を指すため、そのまま登録すると次回ログイン時に無効なパスになる。
 * electron-builder のポータブル NSIS スタブは実体（USBやフォルダに置かれた元exe）の
 * フルパスを `PORTABLE_EXECUTABLE_FILE` に設定するため、あればそちらを優先する。
 */
export function loginItemExecPath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath;
}
