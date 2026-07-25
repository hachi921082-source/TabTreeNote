// src/renderer/components/Tree/FileIcon.tsx
// ツリー行のファイル種別アイコン（インラインSVG、ユーザー要望）。
// 絵文字（📄/🔒）はフルカラー固定グリフで CSS の color を反映できないため、ラベル色に応じて
// 着色できるよう stroke ベースの線画アイコンに置き換えた。ラベル未設定時は既定の文字色に従う。
interface FileIconProps {
  color: string;
  encrypted: boolean;
}

export function FileIcon({ color, encrypted }: FileIconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="tree-row__file-icon"
      aria-hidden="true"
    >
      {encrypted ? (
        <>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </>
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </>
      )}
    </svg>
  );
}
