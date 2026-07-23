// src/renderer/theme/useTheme.ts
// テーマ（light/dark）の状態管理。M1 で settings:get/set（AppSettings.theme）による永続化に
// App.tsx から接続した（初期値の反映は setTheme、変更の永続化は呼び出し側が toggleTheme と
// 併せて settings:set を呼ぶ）。
import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '@shared/models';

export type Theme = AppSettings['theme'];

export function useTheme(initial: Theme = 'light'): {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
} {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  return { theme, toggleTheme, setTheme };
}
