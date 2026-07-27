// src/shared/constants.ts
// 拡張子・一時ファイルプレフィックス・スキーマ版・既定値の集約（docs/data-model.md §5）。

/** メモ本体の拡張子。 */
export const MEMO_EXT_PLAIN = '.txt';
/** 暗号化メモの拡張子（暗号化状態の真実源, DESIGN §2.9）。 */
export const MEMO_EXT_ENCRYPTED = '.txtenc';
/**
 * 【v3 M10a】Markdownメモの拡張子。`.txt`/`.txtenc` と並ぶ「平文相当」の第三拡張子として扱う
 * （`.txt`/`.txtenc`統一空間にそのまま合流。Markdown適用状態の真実源も拡張子, DESIGNv3 §2.4）。
 */
export const MEMO_EXT_MARKDOWN = '.md';

/**
 * 【v3 M10a/M10b共通】Markdownライブプレビューで許可するタグ（DESIGNv3 §2.3、PLANv3 §4）。
 * M10a は全文検索インデックス構築時に、この範囲のタグを `.md` 本文から除去（プレーンテキスト化）
 * した上で索引化する用途で使う（docs/v3/milestones/M10a-markdown-format-core.md「全文検索
 * インデックスへのMarkdown反映」）。M10b（装飾ライブプレビュー描画・サニタイズ）はこの定数を
 * そのまま再利用する想定のため、循環依存を避けて先出しで constants.ts に定義する
 * （milestone doc「developer裁量」の通り）。
 */
export const MARKDOWN_ALLOWED_TAGS = ['span', 'img'] as const;

/**
 * 【v3 M10b】`<span>` の `style` 属性で許可するCSSプロパティ（DESIGNv3 §2.3「CSSプロパティ単位で
 * 許可リストを設ける」）。`color`/`font-size`/`font-weight` の3つのみ許可し、それ以外
 * （`position`/`opacity`/`display`/`background`等）は値ごと除去する。
 */
export const MARKDOWN_ALLOWED_SPAN_STYLE_PROPS = ['color', 'font-size', 'font-weight'] as const;

/**
 * 【v3 M10b/M10c共通】`<img>` で許可する属性（DESIGNv3 §2.3）。`src` はBase64データURI
 * （`MARKDOWN_IMAGE_SRC_PATTERN`）のみ許可し外部URLは許可しない（§2.5 と整合）。
 * 画像貼り付け機能自体はM10cスコープだが、サニタイズ処理（markdownSanitize.ts）はM10bで
 * 実装するため定数はここでまとめて定義する（M10b milestone doc「developer裁量」通り）。
 */
export const MARKDOWN_ALLOWED_IMG_ATTRS = ['src', 'width', 'height'] as const;

/** 【v3 M10b/M10c共通】`<img src="...">` で許可するBase64データURIのパターン（DESIGNv3 §2.3/§2.5）。 */
export const MARKDOWN_IMAGE_SRC_PATTERN = /^data:image\/(png|jpe?g|gif|webp);base64,/;

/**
 * 【v3 M10c】クリップボード/ドロップで貼り付けた画像のサイズ警告閾値（バイト, DESIGNv3 §2.6 Q9）。
 * 「推奨サイズの上限を設けて警告するが、保存自体は禁止しない」（目安: 1画像あたり数百KB〜1MB）。
 * 貼り付け時点で既にメモリ上にある画像の実バイト数（Blob.size）と比較する
 * （docs/v3/milestones/M10c-markdown-toolbar-ui.md「このフェーズで扱う型/データ構造」）。
 */
export const MARKDOWN_IMAGE_SIZE_WARN_BYTES = 500 * 1024;

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

/**
 * 【v3 M8: ノードロック】難読化ファイル名の生成バイト数（128bit, DESIGNv3 §1.4）。
 * `crypto.randomBytes(OBFUSCATED_NAME_BYTES).toString('hex')` で採番する。同一フォルダ内衝突時は
 * 再生成する（obfuscatedNaming.ts）。
 */
export const OBFUSCATED_NAME_BYTES = 16;

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

/**
 * `link:openExternal`（kind='path'）で `shell.openPath` を打ち切るまでのタイムアウト（ms）。
 * tester検証（M5）にて、親フォルダは実在するが対象ファイル自体が存在しないパスを渡すと
 * Windows側のファイル種別解決処理起因と見られる無期限ハングを確認したための安全網。
 * 事前の存在チェック（fs.access）をすり抜けるレースや、その他の環境依存の遅延に対する
 * 最終防御線として、既存の IO_RETRY/SELF_WRITE_TTL の秒オーダーの慣例に合わせた値。
 */
export const LINK_OPEN_PATH_TIMEOUT_MS = 5000;
