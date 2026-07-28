// src/renderer/editor/decorationCommands.ts
// v3 M10b: 文字色/太字/文字サイズの装飾コマンド（右クリックメニュー→post-M10でツールバーへ移設,
// DESIGNv3 §2.2、docs/v3/milestones/M10b-markdown-live-preview.md「Markdown装飾コマンド実行フロー」）。
//
// 既存 `src/renderer/editor/textCommands.ts` と同じパターン（CodeMirror の `changeByRange` で
// 選択範囲を変換、1操作=1トランザクション=Undo1回, DESIGNv3 §2.2）で実装する。選択範囲を
// `<span style="...">...</span>` でラップ/アンラップする。
//
// 【post-M10 bugfix, Bug A】以前の実装（`detectSurroundingSpan`）は「選択範囲の境界が既存spanの
// タグ境界と厳密に一致する」場合しか既存装飾を認識せず、それ以外（既存装飾済み範囲の一部だけを
// 選択して別の装飾を重ねる等）は常に「新規ラップ」として処理していたため、ネストした
// `<span>` を生成してしまい、markdownDecorations.ts の非貪欲マッチと整合しない壊れたHTMLに
// なっていた（外側の `</span>` がプレビュー上で生テキストとして漏れる）。
//
// 修正方針（重なりに対する設計判断）: 選択範囲と重なる既存span（markdownSpanParser.ts の
// `findSpans` で検出、ライブプレビューの描画側と同一の定義を共有）を洗い出し、選択範囲の境界
// および各既存spanの中身の境界で文書を「セグメント」に分割する。各セグメントは常に「選択範囲の
// 内側」か「外側」のどちらか一方に完全に収まる（境界を必ずカットポイントに含めるため）。選択範囲
// 内側のセグメントにだけ、対象CSSプロパティの追加/トグル/明示解除を適用し、外側（選択範囲の外に
// はみ出した既存spanの残り）はそのままの style を保って独立した `<span>` として再構成する
// （＝「既存spanを選択範囲の境界で分割する」設計。ネストは一切生成しないため常にフラットな
// spanの列になり、markdownDecorations.ts の非貪欲マッチと常に整合する）。
// 隣接セグメントの結果styleが一致する場合は1つのタグにまとめる（過度なタグ分割を避ける衛生上の
// 最適化）が、(a)「選択範囲の内側」と「外側」をまたぐ結合、および (b) 文書中で文字位置として
// 実際には隣接していない2セグメントの結合は行わない。(a)は結合すると選択範囲の境界が出力
// テキスト中のどの位置に対応するか復元できなくなるため（両側のセグメントが偶然同じ結果styleに
// なるケースが原理上ありうる — 例: 隣接する2つの別spanのうち一方から選択範囲内でプロパティを
// 外した結果がもう一方の元のstyleと一致する、等）。(b)は選択範囲が2つ以上の既存spanにまたがる
// 場合、`segments[]` の隣り合う要素同士がタグ markup（除外済み）を挟んで実際には非隣接になり
// うるため（post-M10 bugfix, multi-span selection corruption — 詳細は下の merged 構築部の
// コメント参照。styleの一致だけで結合すると `docText.slice()` が除外されたはずのタグ markup を
// 生テキストとして取り込み、閉じタグ漏れ・生の `</span>` 混入・後続セグメントへの適用漏れになる）。
//
// 【post-M10 bugfix, Bug B】上記の「既存spanを検出して同じプロパティを解除する」ロジック自体は
// 元々存在した（同値なら削除するトグル）。実際の不具合は、プレビュー中に装飾済み範囲を
// クリック/ダブルクリックしてもCodeMirrorへ正しい選択範囲が渡らず（markdownDecorations.tsの
// ウィジェットが不透明なDOMのため）、常に選択範囲が空/不正になって「新規ラップ」または
// 「無反応」の分岐に落ちていた点だった。markdownDecorations.ts側でウィジェットクリック時に
// 生成元範囲を直接選択させる修正を行ったため、ここでの重なり解析だけで両方のバグに対応できる
// （太字専用の「解除」分岐を別途設ける必要はない）。
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MarkdownDecorationCommand } from '@shared/ipc-contract';
import { buildOpenTag, findSpans, SPAN_CLOSE_TAG } from './markdownSpanParser';

type StyleProp = 'color' | 'font-weight' | 'font-size';
type StyleMap = Map<string, string>;

function parseStyle(raw: string): StyleMap {
  const map = new Map<string, string>();
  for (const decl of raw.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (prop && value) map.set(prop, value);
  }
  return map;
}

function serializeStyle(map: ReadonlyMap<string, string>): string {
  return [...map.entries()].map(([k, v]) => `${k}: ${v}`).join('; ');
}

interface Segment {
  from: number;
  to: number;
  /**
   * 【post-M10 bugfix, round 3】このセグメントが属する既存spanの「外側」境界。
   * このセグメントが自分のspanの中身の先頭（`from === owner.contentFrom`）でなければ
   * `outerFrom === from`（＝境界の内側扱いは無い）。先頭であれば `outerFrom` は
   * `owner.from`（開始タグ込みの外側境界）になる。中身の末尾についても `outerTo` が同様。
   * spanを持たない地の文セグメントは常に `outerFrom === from` / `outerTo === to`。
   * 選択範囲の境界がspanの「外側タグ境界」に一致した場合（Ctrl+Aやマウスドラッグ選択で
   * 装飾済みspanの直前/直後にスナップする、CodeMirrorの通常の挙動）に、そのタグ全体を
   * 選択範囲に含める/除外する判定に使う（下記 `newFromOffset`/`newToOffset` 参照）。
   */
  outerFrom: number;
  outerTo: number;
  insideSelection: boolean;
  style: StyleMap;
}

interface SegmentSplit {
  /** タグ markup 自体の区間（後述）を除いた、実際の「中身」セグメントのみ。 */
  segments: Segment[];
  /**
   * 実際にCodeMirrorへ渡す変更範囲（トランザクションの`from`/`to`）。既存spanのタグ markup
   * （`<span style="...">`/`</span>`そのものの文字列）を必ずこの範囲に含める（そうしないと、
   * 例えば「選択範囲が既存spanの中身とちょうど一致する」場合に、中身のテキストだけを書き換えても
   * タグ文字そのものは範囲外に残ってしまい、装飾を解除したつもりが実際にはタグが消えない、
   * という不具合になる。実装中に発見, post-M10 bugfix Bug A修正の副産物）。
   */
  tagRegionFrom: number;
  tagRegionTo: number;
}

/**
 * 選択範囲 `[from, to)` と、それに重なる既存spanの境界をすべて集めて、文書を
 * セグメント（選択範囲の内側/外側どちらか一方に完全に収まる区間、各区間のベースstyleつき）に
 * 分割する。まだ装飾コマンドのプロパティ適用/解除は行わない（呼び出し側が各セグメントの
 * `insideSelection`/`style` を見て決める）。
 *
 * 既存spanの「タグ markup そのもの」（`<span style="...">` や `</span>` の生テキスト部分、
 * 中身=contentFrom〜contentToの外側）は、それ単体では「中身」として扱ってはいけない
 * （＝自由に書き換えてよい地の文として扱うと、隣接する別のspanのタグ文字列がそのまま
 * 新しいspanの中身に紛れ込んで壊れたHTMLになる。2つの既存spanが直接隣接している場合や、
 * 選択範囲が1つの既存spanの前後を丸ごと含む場合に発生しうる、実装中に発見した問題）。
 * このタグ markup 区間はセグメントとして返さず、出力からも黙って除外する（既存タグは
 * 常にここで再構成されるため、生テキストをそのまま残す必要はない）。選択範囲の端
 * （`from`/`to`）がそのタグ markup の生テキストの「途中」に入り込んでいる場合（例: ソース表示で
 * `<span style="...">` の途中から選択した等、本パーサが解釈できない稀なケース）は
 * `null` を返し、呼び出し側は安全側で何もしない。
 *
 * 【post-M10 bugfix, round 3】ただし、選択範囲の端がタグ markup 区間の「外側の境界そのもの」
 * （`span.from` または `span.to`、＝タグ markup 全体をちょうど1つのセグメントとして丸ごと含む
 * 場合）は、上記の「途中」ケースとは区別し、null を返さず通常どおりタグ markup として除外
 * （continue）した上で、そのspanの中身セグメントの `outerFrom`/`outerTo`（後述）にこの外側境界を
 * 伝える。これは実際にはよくある正常系: CodeMirrorのデコレーションwidgetは位置解決上アトミックな
 * ため、プレビュー中の通常のマウスドラッグ選択やCtrl+Aは、既存spanの直前/直後で「中身の境界」
 * ではなく「タグ込みの外側境界」にスナップする（reviewer-lite round 2 指摘）。これを「タグの
 * 生テキストの途中に入り込んだ」ケースと誤判定して毎回無反応（サイレントno-op）になっていたのが
 * round 2 で見つかったバグ。判定は「タグ markup 区間の一部だけを切り出したセグメントか、それとも
 * 区間全体をちょうど覆うセグメントか」で行う（前者のみ本当に「途中」、後者は外側境界に一致した
 * だけの正常系）。
 */
function splitIntoSegments(docText: string, from: number, to: number): SegmentSplit | null {
  const overlapping = findSpans(docText).filter((s) => s.contentFrom < to && s.contentTo > from);

  const tagRegionFrom = Math.min(from, ...overlapping.map((s) => s.from));
  const tagRegionTo = Math.max(to, ...overlapping.map((s) => s.to));

  const breakpoints = new Set<number>([tagRegionFrom, tagRegionTo, from, to]);
  for (const s of overlapping) {
    breakpoints.add(s.from);
    breakpoints.add(s.contentFrom);
    breakpoints.add(s.contentTo);
    breakpoints.add(s.to);
  }
  const sorted = [...breakpoints].sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const segFrom = sorted[i];
    const segTo = sorted[i + 1];
    // 型ガード（tsconfig `noUncheckedIndexedAccess`）。ループの範囲上、この2要素は必ず存在する。
    if (segFrom === undefined || segTo === undefined) continue;
    if (segFrom >= segTo) continue; // 重複した境界（例: 選択範囲の端が既存spanの端と一致）は空区間になるため飛ばす。

    const contentOwner = overlapping.find((s) => s.contentFrom <= segFrom && segTo <= s.contentTo);
    if (contentOwner) {
      // このセグメントがそのspanの中身の先頭/末尾ちょうどに一致する場合のみ、外側（タグ込み）
      // 境界を伝える。中身の途中で分割されたセグメント（例: 選択範囲がspanの中身の一部だけを
      // カバーする、中身edge一致のケース）はタグに接していないので outerFrom/outerTo は
      // segFrom/segTo のまま（round 3 コメント参照）。
      const outerFrom = segFrom === contentOwner.contentFrom ? contentOwner.from : segFrom;
      const outerTo = segTo === contentOwner.contentTo ? contentOwner.to : segTo;
      segments.push({
        from: segFrom,
        to: segTo,
        outerFrom,
        outerTo,
        insideSelection: segFrom >= from && segTo <= to,
        style: parseStyle(contentOwner.style)
      });
      continue;
    }

    const tagZoneOwner = overlapping.find(
      (s) => (s.from <= segFrom && segTo <= s.contentFrom) || (s.contentTo <= segFrom && segTo <= s.to)
    );
    if (tagZoneOwner) {
      // round 3: タグ markup 区間の全体をちょうど1セグメントとして覆っているか（＝選択範囲の端が
      // 外側境界そのものに一致しただけの正常系）を判定する。それ以外（区間の一部だけを切り出した
      // セグメント＝本当に境界がタグの生テキストの途中に入り込んでいる）だけを未対応として弾く。
      const isFullOpenTag = segFrom === tagZoneOwner.from && segTo === tagZoneOwner.contentFrom;
      const isFullCloseTag = segFrom === tagZoneOwner.contentTo && segTo === tagZoneOwner.to;
      if (!isFullOpenTag && !isFullCloseTag) return null; // 選択範囲の端がタグ markup の内部（本当の途中）に入り込んでいる。
      continue; // 既存タグの生テキスト（丸ごと）。出力から除外する（コメント参照）。
    }

    segments.push({
      from: segFrom,
      to: segTo,
      outerFrom: segFrom,
      outerTo: segTo,
      insideSelection: segFrom >= from && segTo <= to,
      style: new Map()
    });
  }
  return { segments, tagRegionFrom, tagRegionTo };
}

/**
 * 選択範囲に `prop: value` を適用/トグルする。`explicitClear` が true の場合は既存値と一致するか
 * 問わず常にそのプロパティを除去する（メニュー/ツールバーの「解除」項目用）。
 */
function applyOrToggleSpanStyle(view: EditorView, prop: StyleProp, value: string, explicitClear: boolean): boolean {
  const { state } = view;
  let changed = false;
  const spec = state.changeByRange((range) => {
    if (range.empty) return { range };

    const docText = state.doc.toString();
    const split = splitIntoSegments(docText, range.from, range.to);
    if (split === null) return { range }; // 選択範囲の端が既存タグの生テキストの内部にある等、未対応ケース。安全側で何もしない。
    const { segments, tagRegionFrom, tagRegionTo } = split;
    if (segments.length === 0) return { range };

    // 選択範囲内の全セグメントが既にこのプロパティ=valueを持つ場合のみ「解除」、それ以外は
    // 「全セグメントに適用」（一部だけ装飾済みの範囲を選択して装飾ボタンを押した場合は全体に
    // 統一適用する、一般的なリッチテキストエディタのトグル挙動と同じ設計判断）。
    const insideSegments = segments.filter((s) => s.insideSelection);
    const shouldRemove = explicitClear || (insideSegments.length > 0 && insideSegments.every((s) => s.style.get(prop) === value));

    // 各セグメントの最終styleを決定する（選択範囲外のセグメントは既存spanの残り＝無変更）。
    const resultStyles = segments.map((seg) => {
      if (!seg.insideSelection) return seg.style;
      const next = new Map(seg.style);
      if (shouldRemove) next.delete(prop);
      else next.set(prop, value);
      return next;
    });

    // 隣接セグメントの結果styleが一致する場合はまとめる。ただし選択範囲の内側/外側をまたぐ結合は
    // 行わない（結合すると選択範囲境界が出力テキストのどこに対応するか復元できなくなるため）。
    //
    // 【post-M10 bugfix, multi-span selection corruption】さらに、`last.to === seg.to` になる
    // だけでなく `last.to === seg.from`（＝両セグメントが元の文書中で文字位置として本当に
    // 隣接している）も必須条件にする。splitIntoSegments は既存spanのタグ markup（
    // `</span><span style="...">` など）をセグメントとして返さず黙って除外しているため、
    // 選択範囲が2つ以上の既存spanにまたがる場合、隣り合う `segments[]` 要素同士は必ずしも
    // 文書上で隣接していない（間に除外されたタグ markup 区間が挟まっている）。styleの一致
    // だけを条件にすると、非隣接な2セグメントを1つにまとめてしまい、その間の
    // `docText.slice(seg.from, seg.to)` がスキップされたはずのタグ markup を生テキストとして
    // 取り込んでしまう（結果、閉じタグ漏れ・生の `</span>` 混入・後続セグメントへの適用漏れに
    // つながる。reviewer-lite 指摘）。文字位置が隣接しないセグメントは、たとえ結果styleが
    // 一致していても常に別タグとして出力する（ハイジーン最適化より正しさを優先する）。
    interface MergedSegment {
      from: number;
      to: number;
      /** round 3: 結合グループの最初/最後の要素が持っていた外側境界を引き継ぐ（後述の説明参照）。 */
      outerFrom: number;
      outerTo: number;
      insideSelection: boolean;
      style: StyleMap;
    }
    const merged: MergedSegment[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const style = resultStyles[i];
      // 型ガード（tsconfig `noUncheckedIndexedAccess`）。segments/resultStylesは同じ長さ・同じ
      // インデックスで対応しており、このループ範囲上は必ず存在する。
      if (seg === undefined || style === undefined) continue;
      const last = merged[merged.length - 1];
      if (
        last &&
        last.to === seg.from &&
        last.insideSelection === seg.insideSelection &&
        serializeStyle(last.style) === serializeStyle(style)
      ) {
        last.to = seg.to;
        last.outerTo = seg.outerTo; // 結合グループの末尾が更新されたので、その外側境界も引き継ぐ。
      } else {
        merged.push({ from: seg.from, to: seg.to, outerFrom: seg.outerFrom, outerTo: seg.outerTo, insideSelection: seg.insideSelection, style });
      }
    }

    // トランザクションの置換範囲は「中身」の範囲ではなく、既存spanのタグ markup も含めた
    // tagRegionFrom/tagRegionTo を使う（上のSegmentSplitコメント参照。中身の範囲だけだと
    // 既存タグの生テキストが範囲外に取り残されてしまう）。
    const regionFrom = tagRegionFrom;
    const regionTo = tagRegionTo;

    // 【post-M10 bugfix, round 3】選択範囲の境界（range.from/range.to）が、あるspanの「中身の
    // 境界」（seg.from/seg.to）ではなく「外側のタグ込み境界」（seg.outerFrom/seg.outerTo）に
    // 一致していた場合、新しく生成し直すタグ文字自体も選択に含める必要がある（元の選択が
    // タグ文字ごと含んでいたのだから、復元後の選択もタグ文字ごと含むべき）。
    // `outerFrom !== seg.from`（＝そのセグメントが自分のspanの中身の先頭で、かつ実際にタグが
    // 存在した）の場合だけ「外側一致」を優先し、それ以外（地の文や、中身の途中で分割された
    // セグメント。outerFrom === seg.from）では常に従来どおり「中身境界一致」（タグを含まない）
    // を使う。両者は排他的（1つのspanのタグは空文字列にはならないため同時に一致しえない）。
    let runningOut = 0;
    let newFromOffset: number | null = null;
    let newToOffset: number | null = null;
    const parts: string[] = [];
    for (const seg of merged) {
      const wrap = seg.style.size > 0;
      const beforeTag = runningOut;
      if (wrap) {
        const openTag = buildOpenTag(serializeStyle(seg.style));
        parts.push(openTag);
        runningOut += openTag.length;
      }
      const afterTag = runningOut;
      if (newFromOffset === null) {
        if (seg.outerFrom !== seg.from && seg.outerFrom === range.from) newFromOffset = beforeTag;
        else if (seg.from === range.from) newFromOffset = afterTag;
      }
      const text = docText.slice(seg.from, seg.to);
      parts.push(text);
      runningOut += text.length;
      const afterText = runningOut;
      if (wrap) {
        parts.push(SPAN_CLOSE_TAG);
        runningOut += SPAN_CLOSE_TAG.length;
      }
      const afterClose = runningOut;
      if (newToOffset === null) {
        if (seg.outerTo !== seg.to && seg.outerTo === range.to) newToOffset = afterClose;
        else if (seg.to === range.to) newToOffset = afterText;
      }
    }

    const outputText = parts.join('');
    const originalText = docText.slice(regionFrom, regionTo);
    if (outputText === originalText) return { range }; // 実質無変化（例: 未装飾範囲への明示的な解除）。
    // 安全側フォールバック。round 3 の外側境界対応後は通常の選択（中身境界/外側タグ境界どちらでも）
    // では到達しないはずだが、例えば中身が空の既存span（このアプリの通常のUI操作では生成され得ない
    // が、手書き/破損したMarkdownソースには理論上あり得る）等、`from`/`to` に対応するセグメントが
    // 1つも存在しない病的な入力に対する保険として残す（round 2 で「理論上到達しない」と書いていた
    // 箇所が実際には到達していたことが判明した反省を踏まえ、断定的な表現は避ける）。
    if (newFromOffset === null || newToOffset === null) return { range };

    changed = true;
    return {
      changes: { from: regionFrom, to: regionTo, insert: outputText },
      range: EditorSelection.range(regionFrom + newFromOffset, regionFrom + newToOffset)
    };
  });

  if (!changed) return false;
  view.dispatch(state.update(spec));
  return true;
}

/** `MarkdownToolbar`（`.md`メモ編集中専用ツールバー）の装飾ボタンから呼ばれる。 */
export function runDecorationCommand(view: EditorView, cmd: MarkdownDecorationCommand): void {
  switch (cmd.command) {
    case 'color':
      applyOrToggleSpanStyle(view, 'color', cmd.value, cmd.value === '');
      break;
    case 'bold':
      applyOrToggleSpanStyle(view, 'font-weight', 'bold', false);
      break;
    case 'fontSize':
      applyOrToggleSpanStyle(view, 'font-size', cmd.value, cmd.value === '');
      break;
  }
  view.focus();
}
