// src/main/settings/appSettings.ts
// アプリ設定 JSON（アトミック保存・復旧, PLAN §5.7 / 00-core-principles.md §8「アプリ設定JSON破損」行）。
// メインプロセス内のシングルトンとしてメモリキャッシュを保持し、更新のたびにアトミック保存する
// （個人用途の単一ウィンドウアプリのため、更新競合の排他制御までは M1 スコープでは行わない）。
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_SUFFIX, SCHEMA_VERSION } from '@shared/constants';
import { DEFAULT_SHORTCUTS } from '@shared/shortcuts';
import type { AppSettings, AppSettingsPatch } from '@shared/models';
import { atomicWrite } from '../fs/atomicWrite';
import { migrateSchema } from '../util/migrate';

const SETTINGS_FILE_NAME = 'app-settings.json';

let cached: AppSettings | null = null;

function settingsFilePath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE_NAME);
}

export function defaultAppSettings(): AppSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: app.getVersion(),
    tabs: [],
    window: { x: 100, y: 100, width: 1200, height: 800, maximized: false, treeWidth: 260, treeSide: 'left' },
    theme: 'light',
    uiFontScale: 1,
    lastOpened: null,
    editorDefaults: { wrap: 'window', tabWidth: 4, softTab: true, showLineNumbers: true, fontSize: 14 },
    autosave: { plainDebounceMs: 1500, encryptedDebounceMs: 5000 },
    // ユーザー要望により既定を変更: 確認なしの単純クリックで開く（2026-07-24）。
    links: { openTrigger: 'singleClick', confirmBeforeOpen: false },
    encoding: { defaultSave: 'utf-8' },
    eol: { policy: 'preserve' },
    // 既定ショートカット（M7, DESIGN §2.7「既定は原作を参考に妥当なものを整備。ユーザー設定可能な
    // 構造」）。`shared/shortcuts.ts` に定義を集約する。
    shortcuts: { ...DEFAULT_SHORTCUTS }
  };
}

function isValidAppSettings(value: unknown): value is AppSettings {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.schemaVersion === 'number' && Array.isArray(v.tabs) && typeof v.theme === 'string';
}

async function tryReadSettings(path: string): Promise<AppSettings | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidAppSettings(parsed)) return null;
    // マイグレーション土台（M7, PLAN §7）: v1 のみの現状は no-op だが、将来 schemaVersion を
    // 引き上げた際にここへ変換ステップを追加するだけで済むようにする（docs/00-core-principles.md
    // 経由では触れていない M7 固有の追加）。
    const migrated = migrateSchema(parsed, []);
    // 既定値とのディープマージで不足フィールドを補完する（レビュー指摘 M7-R1-01）。
    // schemaVersion を上げずにフィールドを追加した場合（本 M7 の `shortcuts` 追加など）、
    // 既存ファイルにキーが存在せず `undefined` のまま残ることを防ぐための後方互換処理。
    return deepMerge(defaultAppSettings(), migrated as unknown as AppSettingsPatch);
  } catch {
    return null;
  }
}

export interface InitAppSettingsResult {
  settings: AppSettings;
  recovered: boolean;
  recoveredMessage?: string;
}

/** 起動時初期化（M1 で扱う起動フロー §1）: 読込→復旧カスケード→無ければ既定生成。 */
export async function initAppSettings(): Promise<InitAppSettingsResult> {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const primaryPath = settingsFilePath();
  const bakPath = `${primaryPath}${BACKUP_SUFFIX}`;

  const fileExists = await fs
    .access(primaryPath)
    .then(() => true)
    .catch(() => false);

  if (!fileExists) {
    const settings = defaultAppSettings();
    cached = settings;
    await persist(settings);
    return { settings, recovered: false };
  }

  const primary = await tryReadSettings(primaryPath);
  if (primary) {
    cached = primary;
    return { settings: primary, recovered: false };
  }

  const fromBak = await tryReadSettings(bakPath);
  if (fromBak) {
    cached = fromBak;
    await persist(fromBak);
    return {
      settings: fromBak,
      recovered: true,
      recoveredMessage: 'アプリ設定が破損していたため、直近のバックアップから復旧しました。'
    };
  }

  const settings = defaultAppSettings();
  cached = settings;
  await persist(settings);
  return {
    settings,
    recovered: true,
    recoveredMessage: 'アプリ設定を復旧できなかったため、既定設定で再生成しました。'
  };
}

async function persist(settings: AppSettings): Promise<void> {
  await atomicWrite(settingsFilePath(), Buffer.from(JSON.stringify(settings, null, 2), 'utf-8'));
}

/** 現在のメモリキャッシュを返す。`initAppSettings` 未実行の場合は例外を投げる。 */
export function getAppSettings(): AppSettings {
  if (!cached) {
    throw new Error('appSettings not initialized. Call initAppSettings() first.');
  }
  return cached;
}

/** `mutator` でメモリ上のコピーを書き換え、アトミック保存してキャッシュを更新する。 */
export async function updateAppSettings(mutator: (draft: AppSettings) => void): Promise<AppSettings> {
  const draft: AppSettings = structuredClone(getAppSettings());
  mutator(draft);
  await persist(draft);
  cached = draft;
  return draft;
}

function deepMerge<T>(base: T, patch: AppSettingsPatch | Partial<T>): T {
  // `patch` がオブジェクトでない場合はそのまま採用（値の上書き）。
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch as unknown as T;
  }
  // `base` が undefined/null/非オブジェクトでも、`patch` オブジェクトを起点にマージを続ける
  // （レビュー指摘 M7-R1-01(b)）。従来は `base` 未定義時に patch 全体を捨てて `base` を
  // そのまま返してしまい、設定の部分更新が握りつぶされるバグがあった。
  const result: Record<string, unknown> =
    typeof base === 'object' && base !== null && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(result[key], value as AppSettingsPatch);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/** `settings:set`（深い部分更新）用。 */
export async function patchAppSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  return updateAppSettings((draft) => {
    Object.assign(draft, deepMerge(draft, patch));
  });
}
