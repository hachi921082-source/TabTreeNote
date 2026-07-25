// src/renderer/components/Tree/ContextMenu.tsx
// 汎用の右クリックコンテキストメニュー（Tree/TabBar 双方から利用）。
// 外部ライブラリを追加せず、絶対配置 + 外側クリック/Escape で閉じる最小実装。
import { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  /** submenu 持ちの親項目は onSelect 不要（クリックでサブメニュー開閉するだけ）。 */
  onSelect?: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
  /** 指定するとクリックで開閉するフライアウトサブメニューになる（ユーザー要望: アイコン色選択）。 */
  submenu?: ContextMenuItem[];
  /** ラベル前に丸い色見本を表示する（未指定=表示しない、null=枠線のみの「なし」用）。 */
  swatchColor?: string | null;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={{ left: x, top: y }}>
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`} className="context-menu__item-wrap">
          <button
            type="button"
            className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}${
              item.separatorBefore ? ' context-menu__item--separator' : ''
            }`}
            onClick={() => {
              if (item.submenu) {
                setOpenSubmenu((prev) => (prev === i ? null : i));
                return;
              }
              item.onSelect?.();
              onClose();
            }}
          >
            {item.swatchColor !== undefined && (
              <span className="context-menu__swatch" style={{ backgroundColor: item.swatchColor ?? 'transparent' }} />
            )}
            {item.label}
            {item.submenu && <span className="context-menu__submenu-arrow">▸</span>}
          </button>
          {item.submenu && openSubmenu === i && (
            <div className="context-menu context-menu--submenu">
              {item.submenu.map((sub, j) => (
                <button
                  key={`${sub.label}-${j}`}
                  type="button"
                  className={`context-menu__item${sub.separatorBefore ? ' context-menu__item--separator' : ''}`}
                  onClick={() => {
                    sub.onSelect?.();
                    onClose();
                  }}
                >
                  {sub.swatchColor !== undefined && (
                    <span className="context-menu__swatch" style={{ backgroundColor: sub.swatchColor ?? 'transparent' }} />
                  )}
                  {sub.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
