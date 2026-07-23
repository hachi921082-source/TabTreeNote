// src/renderer/store/selection.ts
// ツリーの複数選択（Ctrl/Shift）状態遷移を計算する純粋関数群（DESIGN §2.2「複数選択（Ctrl/Shift）」）。
// 実際の React state（SelectionState）は呼び出し側（Tree コンポーネント/App）が useState で保持し、
// ここでは「次の選択状態」を計算するロジックだけを切り出す（テスト容易性・再利用性のため）。
export interface SelectionState {
  selected: ReadonlySet<string>;
  /** Shift 範囲選択の起点（直近の通常クリック/Ctrl+クリック対象）。 */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

/** 通常クリック: 単一選択に置き換える。 */
export function selectSingle(memoName: string): SelectionState {
  return { selected: new Set([memoName]), anchor: memoName };
}

/** Ctrl+クリック: 選択集合に対してトグルする（起点は最後にクリックしたものへ更新）。 */
export function toggleSelection(state: SelectionState, memoName: string): SelectionState {
  const next = new Set(state.selected);
  if (next.has(memoName)) {
    next.delete(memoName);
  } else {
    next.add(memoName);
  }
  return { selected: next, anchor: memoName };
}

/**
 * Shift+クリック: `visibleOrder`（現在表示中の行の memoName 配列、表示順）上で
 * 直近の起点（`state.anchor`）から `memoName` までの範囲を選択する。起点未設定/不明な場合は単一選択。
 */
export function rangeSelect(state: SelectionState, visibleOrder: readonly string[], memoName: string): SelectionState {
  if (!state.anchor) return selectSingle(memoName);
  const anchorIndex = visibleOrder.indexOf(state.anchor);
  const targetIndex = visibleOrder.indexOf(memoName);
  if (anchorIndex === -1 || targetIndex === -1) return selectSingle(memoName);
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const next = new Set(visibleOrder.slice(start, end + 1));
  return { selected: next, anchor: state.anchor };
}
