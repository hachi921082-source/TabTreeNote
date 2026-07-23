// src/renderer/components/Editor/CodeMirrorEditor.tsx
// CodeMirror 6 ラッパコンポーネント（M3-①、DESIGN §2.3/§2.4/§6）。
//
// 非制御コンポーネントとして実装する: `initialContentLF` は EditorView 生成時にのみ使用し、
// 以後の入力は `onChange` で親（App.tsx）へ通知するのみで、親からの再レンダーで doc を
// 上書きしない（カーソル位置の消失・意図しない再構築を避けるため）。
//
// メモ切り替え（`instanceKey` の変更）のたびに親側で React の `key` を変え、本コンポーネントを
// アンマウント/再マウントさせる運用を前提とする（DESIGN §2.3「Undo履歴はメモ切り替えで破棄」を
// EditorView の作り直しでそのまま満たす、実装をシンプルに保つ方針）。
import { useEffect, useRef } from 'react';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { AppSettings } from '@shared/models';
import {
  INITIAL_SELECTION,
  buildReadOnlyExtension,
  buildStaticExtensions,
  computeEditorStats,
  createCompartments,
  initialCompartmentExtensions,
  reconfigureEditorSettings,
  reconfigureReadOnly,
  type EditorCompartments,
  type EditorSettings,
  type EditorStats
} from '../../editor/codeMirrorSetup';
import { buildLinkExtension, type DetectedLink } from '../../editor/links';

/**
 * 全文検索の結果ジャンプ（M3-②, docs/milestones/M3-search.md「結果一覧からのジャンプ」）用の
 * 選択・スクロール要求。`token` はクリックのたびに呼び出し側でインクリメントすること
 * （同一位置への再クリックでも `useEffect` の依存差分で確実に再スクロールさせるため）。
 */
export interface RevealTarget {
  from: number;
  to: number;
  token: number;
}

export interface CodeMirrorEditorProps {
  /** 初期表示内容（LF正規化済み, memo:read/readWithEncoding の contentLF）。以後の再レンダーでは無視する。 */
  initialContentLF: string;
  onChange: (contentLF: string) => void;
  onStats: (stats: EditorStats) => void;
  onSave: () => void;
  settings: EditorSettings;
  readOnly?: boolean;
  autoFocus?: boolean;
  /** 全文検索結果からのジャンプ要求（`contentLF` 中の文字オフセット）。 */
  revealTarget?: RevealTarget | null;
  /** リンク（URL/mail/path/`memo:`）のクリック操作方式（M5, DESIGN §2.8。既定 `ctrlClick`）。 */
  linkOpenTrigger: AppSettings['links']['openTrigger'];
  /** リンククリック時のコールバック（実際の外部起動/`memo:` 遷移は呼び出し側=App.tsx に委譲, M5）。 */
  onLinkClick: (link: DetectedLink) => void;
}

export function CodeMirrorEditor({
  initialContentLF,
  onChange,
  onStats,
  onSave,
  settings,
  readOnly = false,
  autoFocus = true,
  revealTarget = null,
  linkOpenTrigger,
  onLinkClick
}: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentsRef = useRef<EditorCompartments | null>(null);

  // 最新のコールバック/読み取り専用フラグを ref で保持し、EditorView 生成用 effect の
  // 依存配列を「マウント時のみ」に保つ（identity が毎レンダー変わっても再マウントしない）。
  const onChangeRef = useRef(onChange);
  const onStatsRef = useRef(onStats);
  const onSaveRef = useRef(onSave);
  const onLinkClickRef = useRef(onLinkClick);
  const linkOpenTriggerRef = useRef(linkOpenTrigger);
  useEffect(() => {
    onChangeRef.current = onChange;
    onStatsRef.current = onStats;
    onSaveRef.current = onSave;
    onLinkClickRef.current = onLinkClick;
    linkOpenTriggerRef.current = linkOpenTrigger;
  }, [onChange, onStats, onSave, onLinkClick, linkOpenTrigger]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const compartments = createCompartments();
    compartmentsRef.current = compartments;

    const state = EditorState.create({
      doc: initialContentLF,
      selection: INITIAL_SELECTION,
      extensions: [
        ...buildStaticExtensions(
          (content) => onChangeRef.current(content),
          (stats) => onStatsRef.current(stats),
          () => onSaveRef.current()
        ),
        // リンク装飾+クリックハンドリング（M5）。コールバック/操作方式は ref 経由で常に最新値を
        // 参照するため、他の設定同様マウント時に一度だけ組み込めばよい（Compartment 不要）。
        ...buildLinkExtension({
          getOpenTrigger: () => linkOpenTriggerRef.current,
          onLinkClick: (link) => onLinkClickRef.current(link)
        }),
        ...initialCompartmentExtensions(compartments, settings),
        compartments.readOnly.of(buildReadOnlyExtension(readOnly))
      ]
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    if (autoFocus) view.focus();
    // EditorView.updateListener は dispatch されたトランザクションにのみ発火し、生成直後の
    // 初期状態では呼ばれないため、マウント直後の文字数/行数/カーソル位置を明示的に通知する
    // （ステータスバーがメモを開いた直後から表示されるように, DESIGN §2.3）。
    onStatsRef.current(computeEditorStats(state));

    return () => {
      view.destroy();
      viewRef.current = null;
      compartmentsRef.current = null;
    };
    // 初期内容/読み取り専用フラグはマウント時のみ適用（非制御）。メモ切り替えは親が key で
    // 再マウントさせる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 設定変更（editorDefaults/フォントサイズ等）は既存 EditorView へ Compartment 経由で反映する。
  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) return;
    reconfigureEditorSettings(view, compartments, settings);
  }, [settings]);

  // readOnly の変更を既存 EditorView へ反映する（M4: 外部変更競合ダイアログ表示中のロック,
  // DESIGN §3.3）。マウント時のみ適用される初期 EditorState 生成とは独立に、以後の変更を
  // 都度 Compartment 経由で反映する（アンマウント/再マウントさせず入力ロックのみ切り替える）。
  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) return;
    reconfigureReadOnly(view, compartments, readOnly);
  }, [readOnly]);

  // 全文検索結果からのジャンプ（M3-②）。マウント用 effect より後に宣言しているため、
  // 同一コミット内で viewRef.current が確実に設定済みの状態で参照できる。
  const lastRevealTokenRef = useRef<number | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealTarget) return;
    if (lastRevealTokenRef.current === revealTarget.token) return;
    lastRevealTokenRef.current = revealTarget.token;

    const docLength = view.state.doc.length;
    const from = Math.max(0, Math.min(revealTarget.from, docLength));
    const to = Math.max(from, Math.min(revealTarget.to, docLength));
    view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'center' })
    });
    view.focus();
  }, [revealTarget]);

  return <div className="cm-editor-host" ref={hostRef} />;
}
