import type { ReactNode } from 'react';

/** Stroke icons (24px grid) for the navigation rail, step cards and the step palette. */
const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 11l9-8 9 8M5 10v10h14V10" />,
  runs: <path d="M5 4h14M5 12h14M5 20h14" />,
  approval: <><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5L15.5 10" /></>,
  flow: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8 7.5l3 8M16 7.5l-3 8" /></>,
  usage: <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  signout: <path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  chev: <path d="M9 6l6 6-6 6" />,
  tool: <><path d="M14.5 6.5a4 4 0 005 5L21 13l-8 8-4-4 8-8zM3 21l5-5" /><path d="M14 4l6 6" /></>,
  script: <path d="M9 4C6 4 7 8 7 10s-1 2-3 2c2 0 3 0 3 2s-1 6 2 6M15 4c3 0 2 4 2 6s1 2 3 2c-2 0-3 0-3 2s1 6-2 6" />,
  agent: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />,
  retrieve: <><circle cx="10" cy="10" r="6" /><path d="M20 20l-5.5-5.5M8 10h4" /></>,
  condition: <><path d="M12 3l9 9-9 9-9-9z" /><path d="M9 12h6" /></>,
  parallel: <path d="M4 12h5M9 12c3 0 3-6 6-6h5M9 12c3 0 3 6 6 6h5" />,
  loop: <path d="M4 12a8 8 0 0113.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 01-13.7 5.7L4 15.5M4 20v-4.5h4.5" />,
  subworkflow: <><rect x="8" y="3" width="13" height="13" rx="3" /><path d="M16 20H6a3 3 0 01-3-3V8" /></>,
  gate: <><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z" /><path d="M12 8v5M12 16h.01" /></>,
  report: <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7" />,
  notify: <path d="M21 3L3 10.5l7 3 3 7zM10 13.5L21 3" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />,
  save: <path d="M5 3h11l4 4v14H5zM8 3v6h8V3M8 21v-7h8v7" />,
  step: <circle cx="12" cy="12" r="4" />,
};

export function Icon({ name, size = 20, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] ?? PATHS.step}
    </svg>
  );
}
