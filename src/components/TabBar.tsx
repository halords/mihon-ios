import type { ReactNode } from 'react';
import { useNav, type TabId } from '../lib/nav';

const tabs: { id: TabId; label: string; icon: ReactNode }[] = [
  {
    id: 'library',
    label: 'Library',
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 5v16" />
        <path d="M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z" />
      </svg>
    ),
  },
  {
    id: 'updates',
    label: 'Updates',
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M20 4v5h-5" />
        <path d="M4 20v-5h5" />
        <path d="M4.5 9a8 8 0 0 1 13.2-3L20 9" />
        <path d="M19.5 15a8 8 0 0 1-13.2 3L4 15" />
      </svg>
    ),
  },
  {
    id: 'history',
    label: 'History',
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M3 4v5h5" />
        <path d="M3 9a9 9 0 1 1 .6 7" />
        <path d="M12 7v5l3 2" />
      </svg>
    ),
  },
  {
    id: 'browse',
    label: 'Browse',
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m16 8-2.5 5.5L8 16l2.5-5.5z" />
      </svg>
    ),
  },
  {
    id: 'more',
    label: 'More',
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="5" cy="12" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="19" cy="12" r="1.5" />
      </svg>
    ),
  },
];

export default function TabBar() {
  const { tab, setTab } = useNav();

  return (
    <nav className="tabbar" aria-label="Main navigation">
      {tabs.map((item) => (
        <button
          key={item.id}
          type="button"
          className={tab === item.id ? 'active' : undefined}
          aria-current={tab === item.id ? 'page' : undefined}
          onClick={() => setTab(item.id)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
