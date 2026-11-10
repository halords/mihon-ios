import { useState } from 'react';
import { deleteCategory, getCategories, getLibrary, getDB, libraryCategories, saveCategory, type CategoryRecord } from '../lib/db';
import { useDataEvents } from '../lib/hooks';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import Icon from '../components/Icon';
import Sheet from '../components/Sheet';
import { toast } from '../components/Feedback';

export default function CategoriesPage() {
  const nav = useNav();
  const { data, reload } = useLoad(async () => ({ categories: await getCategories(), library: await getLibrary() }), []);
  useDataEvents(reload);
  const [editing, setEditing] = useState<CategoryRecord | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); setEditing(null); reload(); } catch (error) { toast(error instanceof Error ? error.message : 'Unable to update category'); }
    finally { setBusy(false); }
  }
  async function move(index: number, delta: number): Promise<void> {
    const list = [...data?.categories ?? []];
    const next = index + delta;
    if (!list[index] || !list[next]) return;
    [list[index], list[next]] = [list[next]!, list[index]!];
    const db = await getDB();
    const tx = db.transaction('categories', 'readwrite');
    for (const [order, category] of list.entries()) await tx.store.put({ ...category, order });
    await tx.done;
  }
  return <main className="screen settings-screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Categories</h1><button className="icon-btn" aria-label="Add category" onClick={() => { setName(''); setEditing({ id: crypto.randomUUID(), name: '', order: data?.categories.length ?? 0 }); }}><Icon name="plus" /></button></header>
    <p className="page-note">A title can belong to several categories. Empty categories and their order are preserved in backups.</p>
    <section className="settings-card">{data?.categories.map((category, index) => <div className="category-row" key={category.id}><Icon name="folder" /><button className="category-name" disabled={category.name === 'Default'} onClick={() => { setName(category.name); setEditing(category); }}><strong>{category.name}</strong><small>{data.library.filter(entry => libraryCategories(entry).includes(category.name)).length} titles</small></button><button className="icon-btn" aria-label={`Move ${category.name} up`} disabled={busy || index === 0} onClick={() => void run(() => move(index, -1))}><span aria-hidden="true">↑</span></button><button className="icon-btn" aria-label={`Move ${category.name} down`} disabled={busy || index === data.categories.length - 1} onClick={() => void run(() => move(index, 1))}><span aria-hidden="true">↓</span></button><button className="icon-btn" aria-label={`Delete ${category.name}`} disabled={busy || category.name === 'Default'} onClick={() => { if (window.confirm(`Delete “${category.name}”? Titles keep their other categories and remain in your library.`)) void run(() => deleteCategory(category.id)); }}><Icon name="trash" size={18} /></button></div>)}</section>
    {editing && <Sheet title={editing.name ? 'Rename category' : 'New category'} onClose={() => setEditing(null)}><label className="field-label">Category name<input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void run(() => saveCategory({ ...editing, name })); }} /></label><button className="btn wide" disabled={busy || !name.trim()} onClick={() => void run(() => saveCategory({ ...editing, name }))}>Save category</button></Sheet>}
  </main>;
}
