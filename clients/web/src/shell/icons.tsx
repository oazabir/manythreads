import type { ReactNode } from 'react';

/* Line icons drawn in SVG rather than font glyphs, so a screen looks the same wherever it is rendered. */

function Svg({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const FilesIcon = () => (
  <Svg>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Svg>
);
export const BoardsIcon = () => (
  <Svg>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M6.2 2.5v11M9.8 2.5v7" />
  </Svg>
);
export const ThreadsIcon = () => (
  <Svg>
    <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5A1.5 1.5 0 0 1 12 10.5H7L4.2 13v-2.5H4A1.5 1.5 0 0 1 2.5 9z" />
  </Svg>
);
export const ApprovalsIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="5.5" />
    <path d="m5.6 8.2 1.8 1.8 3-3.4" />
  </Svg>
);
export const DmIcon = ThreadsIcon;

export const CaretIcon = ({ open = false }: { open?: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ transform: open ? undefined : 'rotate(-90deg)' }}>
    <path d="m2 3.5 3 3 3-3" />
  </svg>
);
export const SearchIcon = () => (
  <Svg size={14}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3 3" />
  </Svg>
);
export const MenuIcon = () => (
  <Svg size={18}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg size={14}>
    <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
  </Svg>
);
export const BackIcon = () => (
  <Svg size={14}>
    <path d="m9.5 3-5 5 5 5" />
  </Svg>
);
export const GearIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
  </Svg>
);

export const LockIcon = () => (
  <Svg size={12}>
    <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
    <path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" />
  </Svg>
);

export const NAV_ICONS = { files: FilesIcon, boards: BoardsIcon, threads: ThreadsIcon, approvals: ApprovalsIcon, dm: DmIcon } as const;

export const ReplyIcon = () => (
  <Svg size={14}>
    <path d="M6.5 3.5 2.5 7.5l4 4M2.5 7.5h6.2a4.3 4.3 0 0 1 4.3 4.3v.7" />
  </Svg>
);
export const SmileIcon = () => (
  <Svg size={14}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M5.8 9.6a2.9 2.9 0 0 0 4.4 0M6 6.4v.2M10 6.4v.2" />
  </Svg>
);
export const MoreIcon = () => (
  <Svg size={14}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />
  </Svg>
);
export const ClipIcon = () => (
  <Svg size={15}>
    <path d="m12.8 7.3-4.9 4.9a3 3 0 0 1-4.2-4.2l5.2-5.2a2 2 0 0 1 2.8 2.8L6.5 10.8a1 1 0 0 1-1.4-1.4l4.6-4.6" />
  </Svg>
);
export const SendIcon = () => (
  <Svg size={15}>
    <path d="M2.5 8 13.5 2.5 9 13.5 7.4 9z M7.4 9l6.1-6.5" />
  </Svg>
);
export const ArrowDownIcon = () => (
  <Svg size={14}>
    <path d="M8 3v9M4 8.5l4 4 4-4" />
  </Svg>
);

export const BellIcon = () => (
  <Svg size={16}>
    <path d="M3.6 11.2V7.4a4.4 4.4 0 0 1 8.8 0v3.8l1 1.4H2.6Z" />
    <path d="M6.6 13.8a1.6 1.6 0 0 0 2.8 0" />
  </Svg>
);
