// src/renderer/components/Search/SearchPanel.tsx
// 全タブ横断の全文検索パネル（M3-②, docs/milestones/M3-search.md）。
// 現在メモ内の検索・置換・正規表現は CodeMirror 内蔵パネル（editor/codeMirrorSetup.ts の
// `search()`）で完結しており本コンポーネントの対象外（DESIGN §2.4）。
// 本コンポーネントは `search:global` による全タブ/現在タブ横断の全文検索、検索履歴の
// 表示・追加、結果一覧からのジャンプ要求（`onJump`）を担う。
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ipc } from '../../ipc';
import type { SearchScope } from '@shared/ipc-contract';
import type { SearchHit, TabInfo } from '@shared/models';

export interface SearchPanelProps {
  tabs: TabInfo[];
  currentTabId: string | null;
  onClose: () => void;
  onJump: (hit: SearchHit) => void;
}

function hitKey(hit: SearchHit, index: number): string {
  return `${hit.tabId}:${hit.memoName}:${hit.matchField}:${hit.lineNumber ?? '-'}:${index}`;
}

export function SearchPanel({ tabs, currentTabId, onClose, onJump }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const lastQueryRef = useRef<{ scope: SearchScope; query: string; caseSensitive: boolean; useRegex: boolean; tabId?: string } | null>(null);

  useEffect(() => {
    ipc
      .getSearchHistory()
      .then((res) => {
        if (res.ok) setHistory(res.value);
      })
      .catch((e: unknown) => console.error('search:history:get failed', e));
  }, []);

  const runSearch = useCallback(
    async (q: string, opts: { scope: SearchScope; caseSensitive: boolean; useRegex: boolean }) => {
      const trimmed = q.trim();
      if (trimmed.length === 0) {
        setResults(null);
        setErrorMessage(null);
        lastQueryRef.current = null;
        return;
      }
      const tabId = opts.scope === 'currentTab' ? (currentTabId ?? undefined) : undefined;
      if (opts.scope === 'currentTab' && !tabId) {
        setResults([]);
        setErrorMessage('現在のタブが選択されていません。');
        return;
      }
      lastQueryRef.current = { ...opts, query: trimmed, tabId };
      setSearching(true);
      setErrorMessage(null);
      try {
        const res = await ipc.searchGlobal({
          scope: opts.scope,
          query: trimmed,
          options: { caseSensitive: opts.caseSensitive, useRegex: opts.useRegex },
          tabId
        });
        if (res.ok) {
          setResults(res.value);
        } else {
          setResults([]);
          setErrorMessage(`検索エラー[${res.error.code}]: ${res.error.message}`);
        }
      } finally {
        setSearching(false);
      }
    },
    [currentTabId]
  );

  // evt:indexUpdated: パネルを開いたまま編集を続けた場合に、表示中の結果を自動的に
  // 再検索して追従させる（PLAN §2.7「UI 側の再検索が必要な場合」）。
  useEffect(() => {
    return ipc.onIndexUpdated(() => {
      const last = lastQueryRef.current;
      if (!last) return;
      void runSearch(last.query, { scope: last.scope, caseSensitive: last.caseSensitive, useRegex: last.useRegex });
    });
  }, [runSearch]);

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void runSearch(query, { scope, caseSensitive, useRegex });
    if (query.trim().length > 0) {
      void ipc
        .addSearchHistory({ query: query.trim() })
        .then(() => ipc.getSearchHistory())
        .then((res) => {
          if (res.ok) setHistory(res.value);
        })
        .catch((e2: unknown) => console.error('search:history:add failed', e2));
    }
  };

  const handleHistoryClick = (q: string): void => {
    setQuery(q);
    void runSearch(q, { scope, caseSensitive, useRegex });
  };

  const handleKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
  };

  const currentTabName = tabs.find((t) => t.id === currentTabId)?.name ?? null;

  return (
    <div className="search-panel-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="全文検索"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-panel__header">
          <span className="search-panel__title">全文検索</span>
          <button type="button" className="modal__close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <form className="search-panel__form" onSubmit={handleSubmit}>
          <input
            className="search-panel__input"
            type="text"
            autoFocus
            placeholder="検索語を入力…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={searching}>
            検索
          </button>

          <div className="search-panel__options">
            <label>
              <input
                type="radio"
                name="search-scope"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
              />
              全タブ
            </label>
            <label>
              <input
                type="radio"
                name="search-scope"
                checked={scope === 'currentTab'}
                onChange={() => setScope('currentTab')}
                disabled={!currentTabId}
              />
              現在のタブ{currentTabName ? `（${currentTabName}）` : ''}
            </label>
            <label>
              <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
              大文字小文字区別
            </label>
            <label>
              <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
              正規表現
            </label>
          </div>
        </form>

        {history.length > 0 && (
          <div className="search-panel__history">
            <span className="search-panel__history-label">履歴:</span>
            {history.map((h) => (
              <button key={h} type="button" className="search-panel__history-item" onClick={() => handleHistoryClick(h)}>
                {h}
              </button>
            ))}
          </div>
        )}

        {errorMessage && <p className="search-panel__error">{errorMessage}</p>}

        <div className="search-panel__results">
          {searching && <p className="search-panel__status">検索中…</p>}
          {!searching && results !== null && results.length === 0 && !errorMessage && (
            <p className="search-panel__status">一致する結果はありません。</p>
          )}
          {!searching &&
            results?.map((hit, i) => (
              <button
                key={hitKey(hit, i)}
                type="button"
                className="search-panel__hit"
                onClick={() => onJump(hit)}
                title={hit.encrypted ? '暗号化メモ（本文プレビューは非対応）' : undefined}
              >
                <span className="search-panel__hit-location">
                  [{hit.tabName}] {hit.memoName}
                  {hit.encrypted ? ' 🔒' : ''}
                  {hit.matchField === 'body' ? ` : ${hit.lineNumber}行目` : ' (メモ名一致)'}
                </span>
                {hit.matchField === 'body' && hit.lineText !== undefined && (
                  <span className="search-panel__hit-preview">{hit.lineText}</span>
                )}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
