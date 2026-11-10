const storageKey = 'mihon-browser-sources';
export function browserSourceEnabled(id: string): boolean {
  try { const ids: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]'); return Array.isArray(ids) && ids.includes(id); } catch { return false; }
}
export function setBrowserSource(id: string, enabled: boolean): void {
  let ids: string[] = [];
  try { const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]'); if (Array.isArray(saved)) ids = saved.filter((item): item is string => typeof item === 'string'); } catch { /* reset invalid preferences */ }
  localStorage.setItem(storageKey, JSON.stringify(enabled ? [...new Set([...ids, id])] : ids.filter(item => item !== id)));
  window.dispatchEvent(new Event('browser-sources-change'));
}
