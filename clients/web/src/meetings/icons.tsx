import type { ReactNode } from 'react';

/* Line icons for the call bar, drawn in SVG like the rest of the app's icons (shell/icons.tsx). */

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const MicIcon = ({ off = false }: { off?: boolean }) => (
  <Svg>
    <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
    <path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2.2M5.6 14.2h4.8" />
    {off ? <path d="M2.4 2.4l11.2 11.2" /> : null}
  </Svg>
);
export const HeadphonesIcon = ({ off = false }: { off?: boolean }) => (
  <Svg>
    <path d="M2.4 10V8a5.6 5.6 0 0 1 11.2 0v2" />
    <rect x="2" y="9.6" width="2.6" height="4" rx="1" />
    <rect x="11.4" y="9.6" width="2.6" height="4" rx="1" />
    {off ? <path d="M2.4 2.4l11.2 11.2" /> : null}
  </Svg>
);
export const PhoneIcon = () => (
  <Svg>
    <path d="M3.2 2.6l2.2-.6 1.3 3-1.4 1a7.4 7.4 0 0 0 3.7 3.7l1-1.4 3 1.3-.6 2.2a1.6 1.6 0 0 1-1.6 1.2A10 10 0 0 1 2 4.2a1.6 1.6 0 0 1 1.2-1.6z" />
  </Svg>
);
export const LeaveIcon = () => (
  <Svg>
    <path d="M6.4 2.4H3.6A1.2 1.2 0 0 0 2.4 3.6v8.8a1.2 1.2 0 0 0 1.2 1.2h2.8M10 5l3 3-3 3M13 8H6" />
  </Svg>
);
export const ChatIcon = () => (
  <Svg>
    <path d="M2.4 3.6A1.2 1.2 0 0 1 3.6 2.4h8.8a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2H7l-3 2.6v-2.6h-.4a1.2 1.2 0 0 1-1.2-1.2z" />
  </Svg>
);
export const CaptionsIcon = () => (
  <Svg>
    <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" />
    <path d="M5 7.4h1.8M8.6 7.4H11M5 10h3.4M10 10h1" />
  </Svg>
);
export const SlidersIcon = () => (
  <Svg>
    <path d="M2.4 4.6h6.4M11.6 4.6h2M2.4 11.4h2M7.2 11.4h6.4" />
    <circle cx="10.2" cy="4.6" r="1.4" />
    <circle cx="5.8" cy="11.4" r="1.4" />
  </Svg>
);
export const WaveIcon = () => (
  <Svg>
    <path d="M2 8h1.2M5 5v6M8 3v10M11 5.6v4.8M14 8h-.2" />
  </Svg>
);
