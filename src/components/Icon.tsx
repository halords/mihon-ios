const paths = {
  back: 'm15 18-6-6 6-6', search: 'm21 21-4.5-4.5 M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  filter: 'M4 7h16M7 12h10M10 17h4', more: 'M5 12h.01M12 12h.01M19 12h.01',
  sort: 'M4 5h10M4 10h7M4 15h4M18 4v16m-3-3 3 3 3-3',
  refresh: 'M20 4v5h-5M4 20v-5h5M4.5 9a8 8 0 0 1 13.2-3L20 9M19.5 15a8 8 0 0 1-13.2 3L4 15',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4', pause: 'M9 5v14M15 5v14', play: 'm8 4 12 8-12 8Z',
  check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M6 18 18 6',
  library: 'M3 4h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H3ZM21 4h-6a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3h6Z',
  history: 'M3 4v5h5M3 9a9 9 0 1 1 .6 7M12 7v5l3 2',
  browse: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0m-5-4-2.5 5.5L8 16l2.5-5.5Z',
  settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',
  folder: 'M3 7V4h6l2 3h10v13H3Z', bookmark: 'M6 3h12v18l-6-4-6 4Z',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  backup: 'M8 3H4v18h16V7l-4-4H8Zm7 0v5h5M8 13h8M8 17h5',
  cloud: 'M6 18a5 5 0 0 1-1-9 7 7 0 0 1 13-1 5 5 0 0 1 0 10H6',
  offline: 'm3 3 18 18M2 8a17 17 0 0 1 4-2m4-1a17 17 0 0 1 12 3M5 12a12 12 0 0 1 6-3m5 1a12 12 0 0 1 3 2M8 16a6 6 0 0 1 8 0M12 20h.01',
  arrow: 'M4 12h16m-6-6 6 6-6 6', migrate: 'M3 7h18m-5-5 5 5-5 5M21 17H3m5-5-5 5 5 5',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  plus: 'M12 4v16M4 12h16', chevron: 'm9 5 7 7-7 7',
} as const;
export type IconName = keyof typeof paths;
export default function Icon({ name, size = 22, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
