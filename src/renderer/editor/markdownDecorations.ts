// src/renderer/editor/markdownDecorations.ts
// v3 M10b: Markdown装飾のライブプレビュー描画（DESIGNv3 §2.1/§2.2、PLANv3 §5.6、
// docs/v3/milestones/M10b-markdown-live-preview.md）。
//
// CodeMirror の ViewPlugin が文書変更を検知し、markdownSanitize.ts の許可リストでサニタイズした
// HTML を見た目として描画する。実データは常に Markdown テキスト（<span style="..."> タグ込みの
// プレーンテキスト）のままであり、装飾はあくまで見た目の変換である（実 doc は一切書き換えない）。
//
// 実装方針: 独自の完全な HTML パーサは実装せず、本アプリの装飾コマンド（decorationCommands.ts）が
// 生成する既知のタグ形（`<span style="...">...</span>` / `<img ...>`）のみを正規表現で検出する。
// 一致した範囲は Decoration.replace + WidgetType で「生のタグ markup を隠し、サニタイズ済み
// HTML を描画するウィジェットに置き換える」形にする（M10c で追加予定のソース/プレビュー切替が
// この ON/OFF を担う想定, milestone doc「依存関係」）。一致しないテキストは一切手を加えない。
//
// 【post-M10 bugfix, Bug B】プレビュー中は `<span>` の描画結果が `contenteditable="false"` の
// ウィジェット（本物の CodeMirror コンテンツではない、任意の DOM）になるため、その中をクリック/
// ダブルクリックしてもブラウザの DOM Selection は CodeMirror にとって解決不能な位置になり、
// 装飾コマンド実行時に不正/collapsed な選択範囲が渡ってしまう（docs/post-M10-changes.md「Markdown
// live preview decoration bugs (M10b)」Bug B の診断通り）。対策として、ウィジェット自身が生成元の
// 文書上の範囲（`contentFrom`/`contentTo`）を知っており、ウィジェット内で mousedown が起きたら
// ブラウザ既定のDOM選択処理を止めて、その範囲をそのまま CodeMirror の選択として確定させる
// （`EditorView.domEventHandlers`）。これにより、装飾済み範囲をクリックすれば常にその装飾の
// 中身全体が選択された状態になり、decorationCommands.ts 側の重なり解析（Bug A の一般化修正）が
// 常に正しい範囲を受け取れる。ウィジェット内部の一部だけを再選択したい場合はソース表示に切り替える
// 運用とする（DESIGNv3 §2.1「上級者向けの逃げ道」）。
import { EditorSelection, type Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { sanitizeMarkdownFragment } from './markdownSanitize';
import { findSpans } from './markdownSpanParser';

/** `<img ...>` または `<img .../>`（自己終了・非終了どちらの記法も許容, M10c 画像貼り付け機能向け）。 */
const IMG_PATTERN = /<img\s+[^<>]*\/?>/g;

/** ウィジェットDOMへ範囲情報を渡す data-* 属性名（domEventHandlers 側と対で使う）。 */
const DECORATION_FROM_ATTR = 'decorationFrom';
const DECORATION_TO_ATTR = 'decorationTo';

class SanitizedMarkdownWidget extends WidgetType {
  /**
   * @param contentRange `<span>` の中身（生成元の文書上の位置）。`<img>` にはクリックで選択すべき
   *   「中身」の概念が無いため `null`（装飾コマンドの対象外, 画像貼り付け機能は本修正のスコープ外）。
   */
  constructor(
    private readonly sanitizedHtml: string,
    private readonly contentRange: { from: number; to: number } | null
  ) {
    super();
  }

  eq(other: SanitizedMarkdownWidget): boolean {
    // 【post-M10 bugfix】`contentRange` も比較対象に含める: 内容文字列が同一でも、文書上の位置が
    // ずれた場合（例: このspanより前の位置での編集）はDOM要素を再生成させ、data-*属性に古い位置が
    // 残ったまま再利用されることを防ぐ（そのまま再利用されると mousedown ハンドラが誤った範囲を
    // 選択してしまう）。
    return (
      other.sanitizedHtml === this.sanitizedHtml &&
      other.contentRange?.from === this.contentRange?.from &&
      other.contentRange?.to === this.contentRange?.to
    );
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'md-decoration';
    if (this.contentRange) {
      container.dataset[DECORATION_FROM_ATTR] = String(this.contentRange.from);
      container.dataset[DECORATION_TO_ATTR] = String(this.contentRange.to);
    }
    // sanitizeMarkdownFragment が DOMPurify で無害化済みのため innerHTML 設定は安全
    // （許可リスト外のタグ・属性・CSSプロパティ・<script>・on*イベント属性・javascript:スキームは
    // 生成時点で既に除去されている, セキュリティ不変条件, DESIGNv3 §2.3）。
    container.innerHTML = this.sanitizedHtml;
    return container;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

type RawMatch =
  | { kind: 'span'; from: number; to: number; raw: string; contentFrom: number; contentTo: number }
  | { kind: 'img'; from: number; to: number; raw: string };

function collectRawMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const span of findSpans(text)) {
    matches.push({
      kind: 'span',
      from: span.from,
      to: span.to,
      raw: text.slice(span.from, span.to),
      contentFrom: span.contentFrom,
      contentTo: span.contentTo
    });
  }
  IMG_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_PATTERN.exec(text))) {
    matches.push({ kind: 'img', from: m.index, to: m.index + m[0].length, raw: m[0] });
    if (m.index === IMG_PATTERN.lastIndex) IMG_PATTERN.lastIndex++; // 空マッチ無限ループの防御（理論上は起きない）。
  }
  matches.sort((a, b) => a.from - b.from);
  return matches;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();

  let lastEnd = -1;
  for (const match of collectRawMatches(text)) {
    // span/img の検出が重なった場合（例: img パターンが span 内容の一部に誤って部分一致した等）は
    // 先勝ちの単純規則で除外する（developer 判断。通常の装飾コマンド生成物では重複自体起きない）。
    if (match.from < lastEnd) continue;
    const sanitized = sanitizeMarkdownFragment(match.raw);
    if (!sanitized) continue; // 許可リストで全除去された場合は装飾なし（プレーンテキストのまま表示）。
    const contentRange = match.kind === 'span' ? { from: match.contentFrom, to: match.contentTo } : null;
    builder.add(match.from, match.to, Decoration.replace({ widget: new SanitizedMarkdownWidget(sanitized, contentRange) }));
    lastEnd = match.to;
  }

  return builder.finish();
}

/**
 * 【post-M10 bugfix, Bug B】装飾ウィジェット内での mousedown を横取りし、ウィジェットが自己申告する
 * 生成元範囲（`data-decoration-from`/`-to`）をそのまま CodeMirror の選択にする。ブラウザ既定の
 * DOM Selection 解決（ウィジェットは通常の CodeMirror コンテンツではないため信頼できない）を
 * 経由させない。
 */
const decorationSelectionHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const widgetEl = target.closest('.md-decoration');
    if (!(widgetEl instanceof HTMLElement)) return false;
    const fromRaw = widgetEl.dataset[DECORATION_FROM_ATTR];
    const toRaw = widgetEl.dataset[DECORATION_TO_ATTR];
    if (fromRaw === undefined || toRaw === undefined) return false;
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;

    event.preventDefault();
    view.dispatch({ selection: EditorSelection.range(from, to) });
    view.focus();
    return true;
  }
});

/**
 * Markdownライブプレビュー描画の ViewPlugin（`.md`メモを開いた場合のみ CodeMirrorEditor.tsx が
 * 組み込む）。文書変更のたびに全文書を再スキャンする（対象は個人用メモ想定で数百KB程度に収まる
 * ため viewport 分割等の最適化は行わない, developer 判断）。
 */
export function buildMarkdownDecorationExtension(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(view);
        }

        update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = buildDecorations(update.view);
          }
        }
      },
      {
        decorations: (plugin) => plugin.decorations
      }
    ),
    decorationSelectionHandler
  ];
}
