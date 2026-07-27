// src/main/search/searchIndex.ts
// メモリ内軽量全文検索インデックス（PLAN §5.1 step4 / DESIGN §2.4 / docs/milestones/M3-search.md）。
//
// 起動時に登録済み全タブの全メモを走査して構築する（buildIndex）。以後は永続ディスクインデックス
// を持たず、次の2経路のみで差分更新する:
//   - 経路①（アプリ内変更, M3 で実装）: 保存・作成・リネーム・削除・移動・コピー・複製などの
//     完了直後に呼び出し側（ipc/memoHandlers.ts・ipc/tabHandlers.ts）が本モジュールの
//     update系関数を直接呼んで反映する。ファイル監視イベントは経由しない。
//   - 経路②（外部からの変更, M4 で実装）: chokidar 監視イベント経由でのみ反映する。
// この分離により、自己発火除外（アプリ発の監視イベントは破棄）と矛盾しない
// （編集直後の全文検索が古い本文にヒットし続ける不具合を防ぐ, DESIGN §2.4）。
//
// 暗号化メモ（.txtenc）は、ロック解除中かどうかに関わらず常に本文をインデックスに含めない
// （対象はメモ名のみ。復号平文をインデックス構造へ持ち込まない, DESIGN §2.4/§2.9）。
import { readMemo, scanTabFolder } from '../fs/memoFileService';

interface IndexEntry {
  encrypted: boolean;
  /** 暗号化メモは常に null（本文はインデックス対象外）。 */
  contentLF: string | null;
}

/** tabId -> memoName -> entry。 */
const index = new Map<string, Map<string, IndexEntry>>();

/**
 * 【v3 M10a】Markdown本文から許可リストタグ（`MARKDOWN_ALLOWED_TAGS` = span/img,
 * src/shared/constants.ts）を除去し、全文検索インデックス用のプレーンテキストへ変換する
 * （DESIGNv3 §2.6 Q11「タグを除去してからインデックス対象にする」、マッチ判定はタグ除去後の
 * プレーンテキスト基準の完全一致とする）。
 * - `<span ...>`/`</span>`: タグ記号のみ除去し、内側のテキストは装飾対象の実文章として残す。
 * - `<img ...>`: 画像は文章として意味を持たないため要素ごと除去する（自己終了/非終了いずれの
 *   記法にも対応）。
 * 本モジュールはメインプロセス側で DOM API を持たないため、DOMPurify 相当の厳密な HTML
 * パーサは使わず正規表現ベースの簡易実装で足りる（マッチ位置への影響が主目的。ライブプレビュー
 * 描画用の厳密なサニタイズは M10b の `markdownSanitize.ts`（DOMPurify）が別途担う）。
 */
export function stripMarkdownTags(text: string): string {
  return text.replace(/<img\b[^>]*>/gi, '').replace(/<\/?span\b[^>]*>/gi, '');
}

/** インデックス格納用に、`.md` のみタグ除去してプレーンテキスト化する（v3 M10a）。 */
function computeIndexedContent(format: 'plain' | 'markdown', contentLF: string): string {
  return format === 'markdown' ? stripMarkdownTags(contentLF) : contentLF;
}

/**
 * 検索処理1回あたりに積み上げるヒット数の上限（安全弁）。DESIGN §4 が想定する
 * 数百〜数千メモ規模を大きく超える異常系（巨大コーパス・全行マッチする正規表現等）で
 * レンダラへ返す配列が無制限に肥大化しないようにする（developer 判断。仕様上の必須要件ではない）。
 */
const MAX_HITS = 1000;

function getOrCreateTabMap(tabId: string): Map<string, IndexEntry> {
  let m = index.get(tabId);
  if (!m) {
    m = new Map();
    index.set(tabId, m);
  }
  return m;
}

/**
 * 単一メモをインデックスへ反映する（経路①: 保存/作成成功の直後に呼ぶ）。
 * `format`（既定 'plain', v3 M10a）: 'markdown' 指定時のみ `stripMarkdownTags` でタグ除去してから
 * 格納する。暗号化メモ（`encrypted:true`）は `format` を無視し常に本文を格納しない。
 */
export function updateMemo(
  tabId: string,
  memoName: string,
  encrypted: boolean,
  contentLF: string | null,
  format: 'plain' | 'markdown' = 'plain'
): void {
  const stored = encrypted || contentLF === null ? null : computeIndexedContent(format, contentLF);
  getOrCreateTabMap(tabId).set(memoName, { encrypted, contentLF: stored });
}

/** インデックスからメモ1件を除去する（削除成功の直後に呼ぶ）。 */
export function removeMemo(tabId: string, memoName: string): void {
  index.get(tabId)?.delete(memoName);
}

/** メモ名変更をインデックスへ反映する（本文は保持したままキーだけ差し替える）。 */
export function renameMemoInIndex(tabId: string, oldName: string, newName: string): void {
  const m = index.get(tabId);
  const entry = m?.get(oldName);
  if (!m || !entry) return;
  m.delete(oldName);
  m.set(newName, entry);
}

/**
 * メモをタブ間（または同一タブ内の複製、`srcTabId === destTabId`）で移動/コピーした結果を
 * インデックスへ反映する。既存エントリをそのまま複製/移設するため、再読込は発生しない。
 * `copy: false` の移動では移動元エントリを削除し、`copy: true` の複製/コピーでは移動元を残す。
 */
export function moveMemoInIndex(
  srcTabId: string,
  memoName: string,
  destTabId: string,
  destMemoName: string,
  copy: boolean
): void {
  const srcMap = index.get(srcTabId);
  const entry = srcMap?.get(memoName);
  if (!entry) return;
  getOrCreateTabMap(destTabId).set(destMemoName, { ...entry });
  if (!copy) srcMap?.delete(memoName);
}

/** タブ登録解除時にインデックスからタブ全体を除去する。 */
export function removeTabFromIndex(tabId: string): void {
  index.delete(tabId);
}

/**
 * タブ1件分のフォルダを（再）走査してインデックスへ反映する。起動時構築 (`buildIndex`) の
 * ほか、`tab:register`（既存フォルダ登録。既存メモが含まれ得る）・`tab:create`（新規フォルダ、
 * 通常は空）の完了直後に呼ぶ。
 */
export async function indexTab(tabId: string, folderPath: string): Promise<void> {
  const scanned = await scanTabFolder(folderPath);
  const tabMap = new Map<string, IndexEntry>();
  for (const s of scanned) {
    if (s.encrypted) {
      tabMap.set(s.memoName, { encrypted: true, contentLF: null });
      continue;
    }
    const res = await readMemo(folderPath, s.memoName);
    const contentLF = res.ok ? res.value.contentLF : '';
    // 【v3 M10a】`.md` はタグ除去してからプレーンテキストとして索引化する（DESIGNv3 §2.6 Q11）。
    tabMap.set(s.memoName, { encrypted: false, contentLF: computeIndexedContent(s.format, contentLF) });
  }
  index.set(tabId, tabMap);
}

/** 起動時インデックス構築（PLAN §5.1 step4）。登録済み全タブを走査する。 */
export async function buildIndex(tabs: readonly { id: string; folderPath: string }[]): Promise<void> {
  index.clear();
  for (const tab of tabs) {
    await indexTab(tab.id, tab.folderPath);
  }
}

// ---------------------------------------------------------------------------
// 検索本体
// ---------------------------------------------------------------------------

export interface SearchQueryOptions {
  caseSensitive?: boolean;
  useRegex?: boolean;
}

export interface SearchQueryHit {
  tabId: string;
  memoName: string;
  encrypted: boolean;
  matchField: 'name' | 'body';
  lineNumber?: number;
  lineText?: string;
  matchStart?: number;
  matchEnd?: number;
}

type Matcher = (text: string) => { index: number; length: number } | null;

/**
 * クエリ文字列からマッチャーを構築する。正規表現が不正な場合は null を返し、
 * 呼び出し側は「ヒットなし」として扱う（IPC 境界のエラーにはしない。検索は基本的に
 * 読み取り操作であり、入力途中の不正な正規表現でエラー表示するとインクリメンタル検索の
 * UX を損なうため。00-core-principles.md §8「検索は基本的に読み取り操作」を踏まえた developer 判断）。
 */
function buildMatcher(query: string, options: SearchQueryOptions): Matcher | null {
  if (query.length === 0) return null;
  if (options.useRegex) {
    let re: RegExp;
    try {
      re = new RegExp(query, options.caseSensitive ? '' : 'i');
    } catch {
      return null;
    }
    return (text: string) => {
      re.lastIndex = 0;
      const m = re.exec(text);
      return m ? { index: m.index, length: m[0].length } : null;
    };
  }
  const needle = options.caseSensitive ? query : query.toLowerCase();
  return (text: string) => {
    const haystack = options.caseSensitive ? text : text.toLowerCase();
    const idx = haystack.indexOf(needle);
    return idx === -1 ? null : { index: idx, length: needle.length };
  };
}

/** 1タブ分のエントリ集合を走査し、ヒットを `out` へ積み上げる（`MAX_HITS` で打ち切り）。 */
function searchInTab(tabId: string, tabMap: Map<string, IndexEntry>, matcher: Matcher, out: SearchQueryHit[]): void {
  for (const [memoName, entry] of tabMap) {
    if (out.length >= MAX_HITS) return;

    const nameMatch = matcher(memoName);
    if (nameMatch) {
      out.push({ tabId, memoName, encrypted: entry.encrypted, matchField: 'name' });
    }

    if (entry.contentLF === null) continue; // 暗号化メモは本文対象外（DESIGN §2.4）。

    const lines = entry.contentLF.split('\n');
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= MAX_HITS) return;
      const line = lines[i] ?? '';
      const m = matcher(line);
      if (m) {
        out.push({
          tabId,
          memoName,
          encrypted: entry.encrypted,
          matchField: 'body',
          lineNumber: i + 1,
          lineText: line,
          matchStart: offset + m.index,
          matchEnd: offset + m.index + m.length
        });
      }
      offset += line.length + 1; // +1 = 分割で失われた '\n' の分。
    }
  }
}

/**
 * 全文検索を実行する（`search:global`）。scope='currentTab' で `tabId` 未指定の場合は
 * 空配列を返す（呼び出し側 IPC ハンドラで弾く想定だが、本関数単体でも安全側に倒す）。
 */
export function search(
  scope: 'all' | 'currentTab',
  tabId: string | undefined,
  query: string,
  options: SearchQueryOptions
): SearchQueryHit[] {
  const matcher = buildMatcher(query, options);
  if (!matcher) return [];

  const out: SearchQueryHit[] = [];
  if (scope === 'currentTab') {
    if (!tabId) return [];
    const tabMap = index.get(tabId);
    if (tabMap) searchInTab(tabId, tabMap, matcher, out);
    return out;
  }

  for (const [tid, tabMap] of index) {
    if (out.length >= MAX_HITS) break;
    searchInTab(tid, tabMap, matcher, out);
  }
  return out;
}
