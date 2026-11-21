import type { ReactNode } from 'react';

// Iconos de trazo propios (24×24). Decorativos: el texto que los acompaña es el que informa.
const P = (d: string) => <path d={d} />;
const ICONS: Record<string, ReactNode> = {
  home: P('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'),
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" />{P('M3 10h18M8 3v4M16 3v4')}</>,
  alert: P('M12 4 2.5 20h19L12 4zM12 10v4M12 17.5v.01'),
  clock: <><circle cx="12" cy="12" r="9" />{P('M12 7v5l3 2')}</>,
  phone: P('M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z'),
  chart: P('M5 20V11M12 20V4M19 20v-7M2 20h20'),
  users: P('M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16.5 11a3.5 3.5 0 1 0-1-6.8M22 21a6 6 0 0 0-4-5.6'),
  message: P('M4 5h16v11H9l-5 4z'),
  star: P('m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'),
  bell: P('M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4'),
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  shield: P('m12 3 8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'),
  settings: <>{P('M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2')}<circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></>,
  building: P('M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M2 21h20M8 8h3M8 12h3M8 16h3'),
  eye: <>{P('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z')}<circle cx="12" cy="12" r="3" /></>,
  user: <><circle cx="12" cy="8" r="4" />{P('M4 21a8 8 0 0 1 16 0')}</>,
  pause: P('M9 5v14M15 5v14'),
  logout: P('M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9'),
  signal: P('M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5v.01'),
  pulse: P('M3 12h4l3-8 4 16 3-8h4'),
  note: <><rect x="5" y="3" width="14" height="18" rx="2" />{P('M9 8h6M9 12h6M9 16h3')}</>,
  check: P('M4 12.5 9.5 18 20 6.5'),
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name] ?? null}
    </svg>
  );
}
