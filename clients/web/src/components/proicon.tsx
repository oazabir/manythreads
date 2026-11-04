import type { ComponentType, SVGProps } from 'react';

/**
 * The UI's icons come from ProIcons (`@proicons/react`, MIT; 24-grid line icons). This file is the one place that sets how they look,
 * so every screen draws them the same way: `currentColor`, hidden from screen readers (the button carries the label) and a stroke
 * a little heavier than the library's 1.5, because the app draws them at 12-18 px where 1.5 on a 24 grid looks faint.
 */
export type ProIconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;

export function proIcon(Icon: ProIconComponent, size = 16, strokeWidth = 2) {
  return function ProIconView(props: { size?: number; strokeWidth?: number; filled?: boolean; className?: string }) {
    return <Icon size={props.size ?? size} strokeWidth={props.strokeWidth ?? strokeWidth} fill={props.filled ? 'currentColor' : 'none'} className={props.className} aria-hidden="true" focusable="false" style={{ verticalAlign: '-0.15em', flexShrink: 0 }} />;
  };
}
