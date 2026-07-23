// src/shared/constants.ts
// 拡張子・一時ファイルプレフィックス・スキーマ版・既定値の集約（docs/data-model.md §5）。

/** メモ本体の拡張子。 */
export const MEMO_EXT_PLAIN = '.txt';
/** 暗号化メモの拡張子（暗号化状態の真実源, DESIGN §2.9）。 */
export const MEMO_EXT_ENCRYPTED = '.txtenc';

/** フォルダ内タブ単位メタJSONのファイル名（DESIGN §3.2）。 */
export const META_FILE_NAME = '.tabtreenote.json';

/**
 * アトミック書き込みで使う一時ファイルのプレフィックス規則（DESIGN §3.3）。
 * 例: `.~tmp~<ランダム文字列>~<元のファイル名>`
 * chokidar の `ignored` オプションでこのパターンごと監視除外する（M4 で使用）。
 */
export const TEMP_FILE_PREFIX = '.~tmp~';
/** temp ファイル名を判定する glob 風パターン（watcher の ignored 設定に使用）。 */
export const TEMP_FILE_GLOB = `**/${TEMP_FILE_PREFIX}*`;

/** アトミック書き込みが生成する直近1世代バックアップの拡張子サフィックス（DESIGN §2.6）。 */
export const BACKUP_SUFFIX = '.bak';

/** 現行スキーマ版（メタJSON / アプリ設定JSON 共通）。 */
export const SCHEMA_VERSION = 1;

/** `.txtenc` フォーマットの識別子（data-model.md §3）。 */
export const TXTENC_MAGIC = 'TTNENC';
export const TXTENC_FORMAT_VERSION = 1;

/** scrypt 既定コストパラメータ（PLAN §8-4。ファイルに記録し復号時はファイル内の値を使う）。 */
export const SCRYPT_DEFAULTS = {
  N: 32768, // 2^15
  r: 8,
  p: 1,
  keyLen: 32
} as const;

/** AES-GCM の IV 長（バイト）。書き込み毎に必ず新規生成する（DESIGN §2.9）。 */
export const GCM_IV_LENGTH = 12;
/** scrypt salt の最小長（バイト）。 */
export const SCRYPT_SALT_MIN_LENGTH = 16;

/** 自己書き込み予約テーブル（selfWriteRegistry）の TTL フォールバック既定値（ms, 00-core-principles.md §4）。 */
export const SELF_WRITE_TTL_MS = 2500;

/**
 * ファイル監視（chokidar）のデバウンス既定値（ms, 00-core-principles.md §4 / PLAN §5.6）。
 * 同一パスへの連続イベントを集約する。selfWriteRegistry の TTL（2500ms）より十分短く、
 * Windows の I/O バッファリング遅延に余裕を持たせるため 100-300ms の範囲を採る。
 */
export const WATCH_DEBOUNCE_MS = 200;

/**
 * chokidar の `ignored` 判定で除外する Windows OS 生成ファイル名（小文字比較, Fix10）。
 * 一時ファイルプレフィックス（TEMP_FILE_PREFIX）・`.bak` サフィックスとあわせて監視除外する。
 */
export const OS_JUNK_FILE_NAMES = new Set(['desktop.ini', 'thumbs.db']);

/** Windows ロックエラー（EBUSY/EPERM 等）リトライの既定値（00-core-principles.md §7）。 */
export const IO_RETRY_COUNT = 5;
export const IO_RETRY_BASE_DELAY_MS = 50;
export const IO_RETRY_MAX_DELAY_MS = 200;

/** 長パス警告の閾値（絶対パス文字数, DESIGN §4）。 */
export const LONG_PATH_THRESHOLD = 260;
