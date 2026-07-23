// src/renderer/editor/links.ts
// リンク装飾（URL/mail/path/`memo:` の検出）と CodeMirror 6 拡張（PLAN §5.8 / DESIGN §2.8）。
//
// 本文中のパターンを検出し CodeMirror デコレーション（下線+専用クラス）を付与する。
// 実際の外部起動/`memo:` 遷移（IPC 呼び出し・確認ダイアログ）はこのモジュールでは行わず、
// クリック検出時に `onLinkClick` コールバックへ委譲する（CodeMirrorEditor.tsx が
// onChange/onStats/onSave と同様に親コンポーネント（App.tsx）へ処理を渡すパターンに合わせる）。
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { AppSettings } from '@shared/models';

export type LinkKind = 'url' | 'mailto' | 'path' | 'memo';

export interface DetectedLink {
  kind: LinkKind;
  /** 検出された元テキスト（`memo:`/`mailto:` プレフィックスを含む。前後の空白等は含まない）。 */
  raw: string;
  from: number;
  to: number;
}

/**
 * 本文中のリンク候補を検出する正規表現。
 * 優先順位（左の代替が先に試される）: `memo:` 記法 → URL（スキーム明示/`www.`）→ `mailto:` 明示
 * → 素のメールアドレス → ファイルパス（ドライブレター/`.\`/`..\`/`file://`）。
 * 各代替は開始位置ごとに排他的（同じ開始位置で複数が同時マッチすることはない）。
 */
const LINK_PATTERN =
  /(memo:\S+)|((?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'）」』]+)|(mailto:\S+)|([A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)|((?:[A-Za-z]:\\|\.\\|\.\.\\|file:\/\/)[^\s<>"'）」』]*)/g;

/** リンク末尾に紛れ込みやすい文末記号・閉じ括弧類を取り除く（対応する開き括弧の有無までは見ない簡易実装）。 */
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}」』】、。]+$/;

function trimTrailingPunctuation(raw: string): string {
  return raw.replace(TRAILING_PUNCTUATION_RE, '');
}

/** 文書全文からリンク候補を検出する（小規模なプレーンテキストメモを想定, developer 判断）。 */
export function detectLinks(text: string): DetectedLink[] {
  const results: DetectedLink[] = [];
  LINK_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- global regex の逐次 exec 走査
  while ((m = LINK_PATTERN.exec(text))) {
    const [, memo, url, mailtoExplicit, email, path] = m;
    let kind: LinkKind;
    let raw: string;
    if (memo !== undefined) {
      kind = 'memo';
      raw = memo;
    } else if (url !== undefined) {
      kind = 'url';
      raw = url;
    } else if (mailtoExplicit !== undefined) {
      kind = 'mailto';
      raw = mailtoExplicit;
    } else if (email !== undefined) {
      kind = 'mailto';
      raw = email;
    } else if (path !== undefined) {
      kind = 'path';
      raw = path;
    } else {
      continue;
    }

    const trimmed = kind === 'memo' ? raw : trimTrailingPunctuation(raw);
    if (trimmed.length === 0) continue;
    results.push({ kind, raw: trimmed, from: m.index, to: m.index + trimmed.length });
  }
  return results;
}

const linkMarkDecoration = Decoration.mark({ class: 'cm-link' });

function buildDecorations(links: readonly DetectedLink[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const link of links) {
    builder.add(link.from, link.to, linkMarkDecoration);
  }
  return builder.finish();
}

class LinkDecorationPluginValue implements PluginValue {
  links: DetectedLink[];
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.links = detectLinks(view.state.doc.toString());
    this.decorations = buildDecorations(this.links);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.links = detectLinks(update.state.doc.toString());
      this.decorations = buildDecorations(this.links);
    }
  }
}

const linkDecorationPlugin = ViewPlugin.fromClass(LinkDecorationPluginValue, {
  decorations: (v) => v.decorations
});

export interface LinkExtensionOptions {
  /** クリック判定時点の最新の操作方式を返す（設定変更を Compartment 無しで反映するため）。 */
  getOpenTrigger: () => AppSettings['links']['openTrigger'];
  onLinkClick: (link: DetectedLink) => void;
}

function isTriggerMatch(
  trigger: AppSettings['links']['openTrigger'],
  eventType: 'click' | 'dblclick',
  event: MouseEvent
): boolean {
  if (trigger === 'ctrlClick') return eventType === 'click' && event.ctrlKey;
  if (trigger === 'singleClick') return eventType === 'click';
  return eventType === 'dblclick'; // 'doubleClick'
}

function handlePointerEvent(event: MouseEvent, view: EditorView, eventType: 'click' | 'dblclick', options: LinkExtensionOptions): boolean {
  if (!isTriggerMatch(options.getOpenTrigger(), eventType, event)) return false;

  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return false;

  const plugin = view.plugin(linkDecorationPlugin);
  const link = plugin?.links.find((l) => pos >= l.from && pos <= l.to);
  if (!link) return false;

  event.preventDefault();
  options.onLinkClick(link);
  return true;
}

/**
 * リンク装飾+クリックハンドリングの CodeMirror 拡張一式を構築する。
 * `onLinkClick`/`getOpenTrigger` は呼び出し側（CodeMirrorEditor.tsx）が ref 経由で
 * 常に最新のコールバック/設定を返すようにラップして渡すこと（onChange 等と同じパターン）。
 */
export function buildLinkExtension(options: LinkExtensionOptions) {
  return [
    linkDecorationPlugin,
    EditorView.domEventHandlers({
      click: (event, view) => handlePointerEvent(event, view, 'click', options),
      dblclick: (event, view) => handlePointerEvent(event, view, 'dblclick', options)
    })
  ];
}
