import { useNav } from '../lib/nav';

export default function MorePage() {
  const { openSettings } = useNav();

  return (
    <main className="screen">
      <header className="topbar">
        <h1>More</h1>
      </header>
      <div className="card">
        <div className="list-row">
          <button
            type="button"
            className="btn-ghost"
            onClick={openSettings}
          >
            Settings
          </button>
        </div>
      </div>
      <div className="empty">
        <p>Manage your reading preferences.</p>
      </div>
    </main>
  );
}
