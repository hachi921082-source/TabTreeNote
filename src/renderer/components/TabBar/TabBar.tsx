// src/renderer/components/TabBar/TabBar.tsx
// タブバー（DESIGN §2.1）。タブ切替・並べ替え（DND, tab:reorder）・右クリックでの
// リネーム/削除・既存フォルダの DND 登録・ツリー行からのドロップ（タブ間移動・コピー）を扱う。
import { useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { TabInfo } from '@shared/models';
import { ContextMenu, type ContextMenuItem } from '../Tree/ContextMenu';
import { MEMO_DND_MIME, type MemoDragPayload } from '../Tree/treeView';

const TAB_DND_MIME = 'application/x-ttn-tab';

export interface TabBarProps {
  tabs: TabInfo[];
  selectedTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onReorder: (orderedTabIds: string[]) => void;
  onRequestRegister: () => void;
  onRequestCreate: () => void;
  onRequestRename: (tabId: string) => void;
  onRequestRemove: (tabId: string, deleteFolder: boolean) => void;
  onDropMemo: (destTabId: string, payload: MemoDragPayload, copy: boolean) => void;
  onDropExternalFolder: (folderPath: string) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  /** 全文検索パネルを開く（M3-②, docs/milestones/M3-search.md）。 */
  onRequestSearch: () => void;
}

interface TabContextMenuState {
  x: number;
  y: number;
  tabId: string;
}

export function TabBar({
  tabs,
  selectedTabId,
  onSelectTab,
  onReorder,
  onRequestRegister,
  onRequestCreate,
  onRequestRename,
  onRequestRemove,
  onDropMemo,
  onDropExternalFolder,
  theme,
  onToggleTheme,
  onRequestSearch
}: TabBarProps) {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<{ tabId: string; side: 'left' | 'right' } | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);

  const handleTabDragStart = (tabId: string, e: ReactDragEvent): void => {
    setDraggingTabId(tabId);
    e.dataTransfer.setData(TAB_DND_MIME, tabId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleTabDragOver = (tabId: string, e: ReactDragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer.types.includes(TAB_DND_MIME) && draggingTabId && draggingTabId !== tabId) {
      const rect = e.currentTarget.getBoundingClientRect();
      const side = e.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
      setDropSide({ tabId, side });
    }
  };

  const handleTabDrop = (tabId: string, e: ReactDragEvent): void => {
    e.preventDefault();
    setDropSide(null);

    const memoRaw = e.dataTransfer.getData(MEMO_DND_MIME);
    if (memoRaw) {
      try {
        const payload = JSON.parse(memoRaw) as MemoDragPayload;
        onDropMemo(tabId, payload, e.ctrlKey);
      } catch {
        /* 不正な payload は無視 */
      }
      setDraggingTabId(null);
      return;
    }

    const draggedTabId = e.dataTransfer.getData(TAB_DND_MIME);
    if (draggedTabId && draggedTabId !== tabId) {
      const side = (() => {
        const rect = e.currentTarget.getBoundingClientRect();
        return e.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
      })();
      const withoutDragged = tabs.filter((t) => t.id !== draggedTabId).map((t) => t.id);
      const targetIndex = withoutDragged.indexOf(tabId);
      const insertAt = side === 'left' ? targetIndex : targetIndex + 1;
      const next = [...withoutDragged.slice(0, insertAt), draggedTabId, ...withoutDragged.slice(insertAt)];
      onReorder(next);
    }
    setDraggingTabId(null);
  };

  const handleBarDragOver = (e: ReactDragEvent): void => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(MEMO_DND_MIME)) {
      e.preventDefault();
    }
  };

  const handleBarDrop = (e: ReactDragEvent): void => {
    // ツリー外(タブバー背景)への物理フォルダのドラッグ&ドロップでタブ登録する（DESIGN §2.1）。
    if (e.dataTransfer.files.length > 0) {
      e.preventDefault();
      for (const file of Array.from(e.dataTransfer.files)) {
        // Electron のレンダラでは File オブジェクトに絶対パスが付与される。
        const maybePath = (file as File & { path?: string }).path;
        if (maybePath) onDropExternalFolder(maybePath);
      }
    }
  };

  const buildContextMenuItems = (tabId: string): ContextMenuItem[] => [
    { label: '名前変更', onSelect: () => onRequestRename(tabId) },
    {
      label: 'タブを削除（登録解除のみ・フォルダは残す）',
      danger: true,
      separatorBefore: true,
      onSelect: () => onRequestRemove(tabId, false)
    },
    { label: 'タブとフォルダを削除（ごみ箱へ）', danger: true, onSelect: () => onRequestRemove(tabId, true) }
  ];

  const handleContextMenu = (tabId: string, e: ReactMouseEvent): void => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  };

  return (
    <div className="app__tabbar" onDragOver={handleBarDragOver} onDrop={handleBarDrop}>
      <span className="app__tabbar-title">TabTreeNote</span>
      <div className="app__tabbar-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            draggable
            className={[
              'app__tab',
              t.id === selectedTabId ? 'app__tab--active' : '',
              dropSide?.tabId === t.id ? `app__tab--drop-${dropSide.side}` : ''
            ]
              .filter(Boolean)
              .join(' ')}
            title={t.folderPath}
            onClick={() => onSelectTab(t.id)}
            onContextMenu={(e) => handleContextMenu(t.id, e)}
            onDragStart={(e) => handleTabDragStart(t.id, e)}
            onDragOver={(e) => handleTabDragOver(t.id, e)}
            onDragLeave={() => setDropSide((prev) => (prev?.tabId === t.id ? null : prev))}
            onDrop={(e) => handleTabDrop(t.id, e)}
            onDragEnd={() => {
              setDraggingTabId(null);
              setDropSide(null);
            }}
          >
            {t.name}
          </button>
        ))}
        <button type="button" className="app__tab app__tab--add" onClick={onRequestRegister} title="既存フォルダを登録">
          📂+
        </button>
        <button type="button" className="app__tab app__tab--add" onClick={onRequestCreate} title="新規タブ作成">
          ＋
        </button>
      </div>
      <button type="button" className="app__theme-toggle" onClick={onRequestSearch} title="全文検索（Ctrl+Shift+F）">
        🔍 検索
      </button>
      <button type="button" className="app__theme-toggle" onClick={onToggleTheme}>
        {theme === 'light' ? 'Dark モードへ' : 'Light モードへ'}
      </button>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems(contextMenu.tabId)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
