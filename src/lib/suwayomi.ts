// Suwayomi runs the Android extension code; this PWA remains the local
// library and reader. Source and chapter URLs stay identical to Mihon.
import { getDB, getManga, getChapterMetas, dispatchDataEvent, type ArchiveRecord } from './db';
import { loadSettings, saveSettings, onSettingsChange } from './settings';
import { fetchWithTimeout } from './fetchJson';
import { registerSource, unregisterSource } from '../sources';
import { mangaKey, type Source, type SChapter, type SManga } from '../sources/Source';
import { coverArt } from '../sources/svgArt';

export interface ServerSource { id: string; name: string; lang: string; supportsLatest: boolean; baseUrl?: string }
type ConnectionState = { status: 'disconnected' | 'connecting' | 'connected' | 'offline' | 'error'; url: string; sources: ServerSource[]; error?: string };
let state: ConnectionState = { status: 'disconnected', url: '', sources: [] };
const listeners = new Set<() => void>();
const registeredSourceIds = new Set<string>();
let initialized = false;
let connectionRun = 0;
export function subscribeConnection(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function getConnectionSnapshot(): ConnectionState { return state; }
function publish(patch: Partial<ConnectionState>): void { state = { ...state, ...patch }; for (const fn of listeners) fn(); }

// GraphQL Long may arrive as a JSON number. Quote only unsafe integer tokens
// outside JSON strings before parsing, so a 64-bit source ID stays exact.
export function parseServerJson(text: string): unknown {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      output += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; output += c; }
    else if (c === '-' || /[0-9]/.test(c)) {
      const token = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))?.[0];
      if (!token) { output += c; continue; }
      const unsafe = /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token));
      output += unsafe ? `"${token}"` : token;
      i += token.length - 1;
    } else output += c;
  }
  return JSON.parse(output);
}

export function serverUrl(path: string, base = loadSettings().suwayomiUrl): string {
  if (!base) throw new Error('Connect a Suwayomi server first');
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
export function backendHeaders(): Headers {
  const headers = new Headers();
  try { const auth = sessionStorage.getItem('mihon:backend-auth'); if (auth) headers.set('Authorization', auth); } catch { /* no session storage */ }
  return headers;
}
export function setBackendAuth(username: string, password: string): void {
  if (!username) { sessionStorage.removeItem('mihon:backend-auth'); return; }
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  sessionStorage.setItem('mihon:backend-auth', `Basic ${btoa(binary)}`);
}

export async function serverGraphql<T>(query: string, variables: Record<string, unknown> = {}, base = loadSettings().suwayomiUrl, signal?: AbortSignal): Promise<T> {
  const headers = backendHeaders();
  headers.set('Content-Type', 'application/json');
  const response = await fetchWithTimeout(serverUrl('api/graphql', base), { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal, credentials: 'same-origin' }, 60000);
  if (response.status === 401 || response.status === 403) { void response.body?.cancel(); throw new Error('Suwayomi requires authentication. Enter server credentials in Connections.'); }
  if (!response.ok) { void response.body?.cancel(); throw new Error(`Suwayomi request failed (HTTP ${response.status})`); }
  const result = parseServerJson(await response.text()) as { data?: T; errors?: { message: string }[]; error?: string };
  if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join(' · '));
  if (!result.data) throw new Error(result.error ?? 'The server did not return GraphQL data. Check the Suwayomi URL.');
  return result.data;
}

interface ServerManga { id: number; url: string; title: string; thumbnailUrl?: string; author?: string; artist?: string; description?: string; genre?: string[]; status?: string }
interface ServerChapter { id: number; url: string; name: string; chapterNumber: number; uploadDate: number | string; scanlator?: string; sourceOrder: number }
const MANGA_FIELDS = 'id url title author artist description genre status thumbnailUrl';
const CHAPTER_FIELDS = 'id url name chapterNumber uploadDate scanlator sourceOrder';
function normalizeUrl(url: string, base?: string): string {
  try { const parsed = new URL(url, base || 'https://source.local'); return `${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`; }
  catch { return url.replace(/\/+$/, ''); }
}

function makeSource(info: ServerSource, base: string): Source {
  const resolving = new Map<string, Promise<number>>();
  const refreshing = new Map<string, { at: number; promise: Promise<{ manga: ServerManga; chapters: ServerChapter[] }> }>();
  function toManga(m: ServerManga): SManga {
    const statuses: Record<string, SManga['status']> = { ONGOING: 'Ongoing', COMPLETED: 'Completed', ON_HIATUS: 'On Hold', CANCELLED: 'Cancelled', LICENSED: 'Licensed', PUBLISHING_FINISHED: 'Publishing Finished' };
    return { id: m.url, sourceId: info.id, sourceName: info.name, url: m.url, title: m.title,
      author: m.author, artist: m.artist, description: m.description ?? '', genres: m.genre ?? [], status: statuses[m.status ?? ''] ?? 'Unknown',
      coverUrl: m.thumbnailUrl ? `${serverUrl(`api/v1/manga/${m.id}/thumbnail`, base)}#${encodeURIComponent(mangaKey(info.id, m.url))}` : coverArt(m.title, m.author, 230) };
  }
  async function list(type: 'POPULAR' | 'LATEST' | 'SEARCH', page: number, query?: string, signal?: AbortSignal): Promise<SManga[]> {
    const data = await serverGraphql<{ fetchSourceManga: { mangas: ServerManga[] } }>(
      `mutation SourceManga($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { mangas { ${MANGA_FIELDS} } } }`,
      { input: { source: info.id, type, page, ...(query === undefined ? {} : { query }) } }, base, signal);
    const db = await getDB();
    for (const manga of data.fetchSourceManga.mangas) await db.put('backendBindings', { key: mangaKey(info.id, manga.url), server: base, mangaId: manga.id });
    return data.fetchSourceManga.mangas.map(toManga);
  }
  async function resolve(url: string, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const key = mangaKey(info.id, url);
    const db = await getDB();
    // Database IDs can be reused after a server is restored or replaced at
    // the same URL. Verify the source and original manga URL before trusting
    // any persisted binding; cached offline pages never require this lookup.
    const data = await serverGraphql<{ mangas: { nodes: ServerManga[] } }>(
      `query ResolveManga($condition: MangaConditionInput!) { mangas(condition: $condition, first: 1) { nodes { ${MANGA_FIELDS} } } }`, { condition: { sourceId: info.id, url } }, base, signal);
    let remote = data.mangas.nodes[0];
    if (!remote) {
      const stored = await getManga(key);
      if (stored) {
        const candidates = await list('SEARCH', 1, stored.manga.title, signal);
        const match = candidates.find(m => normalizeUrl(m.id, info.baseUrl) === normalizeUrl(url, info.baseUrl));
        if (match) {
          const found = await db.get('backendBindings', mangaKey(info.id, match.id));
          if (found) { await db.put('backendBindings', { ...found, key }); return found.mangaId; }
        }
      }
      throw new Error('This title is not in Suwayomi yet. Send your retained Mihon backup from Connections, or migrate the title to an available source.');
    }
    await db.put('backendBindings', { key, server: base, mangaId: remote.id });
    return remote.id;
  }
  async function ensureManga(url: string, signal?: AbortSignal): Promise<number> {
    if (signal) return resolve(url, signal);
    let promise = resolving.get(url);
    if (!promise) { promise = resolve(url); resolving.set(url, promise); }
    try { return await promise; } finally { resolving.delete(url); }
  }
  async function refreshManga(url: string, signal?: AbortSignal) {
    const cached = refreshing.get(url);
    if (!signal && cached && Date.now() - cached.at < 3000) return cached.promise;
    const promise = (async () => {
      const id = await ensureManga(url, signal);
      const data = await serverGraphql<{ fetchMangaAndChapters: { manga: ServerManga; chapters: ServerChapter[] } }>(
        `mutation RefreshManga($input: FetchMangaAndChaptersInput!) { fetchMangaAndChapters(input: $input) { manga { ${MANGA_FIELDS} } chapters { ${CHAPTER_FIELDS} } } }`,
        { input: { id, fetchManga: true, fetchChapters: true } }, base, signal);
      return data.fetchMangaAndChapters;
    })();
    if (!signal) refreshing.set(url, { at: Date.now(), promise });
    try { return await promise; } catch (error) { if (!signal) refreshing.delete(url); throw error; }
  }
  async function loadChapters(url: string, signal?: AbortSignal): Promise<SChapter[]> {
    const { chapters } = await refreshManga(url, signal);
    const old = await getChapterMetas(mangaKey(info.id, url));
    return chapters.map(c => {
      const match = old.find(o => normalizeUrl(o.chapter.url ?? o.chapter.id, info.baseUrl) === normalizeUrl(c.url, info.baseUrl));
      const date = Number(c.uploadDate);
      return { id: match?.chapter.id ?? c.url, mangaId: url, url: c.url, name: c.name, number: c.chapterNumber,
        dateUpload: date > 0 && date < 100_000_000_000 ? date * 1000 : date, scanlator: c.scanlator, sourceOrder: c.sourceOrder, backendId: c.id };
    });
  }
  const source: Source = {
    id: info.id, name: info.name, lang: info.lang, kind: 'suwayomi', supportsLatest: info.supportsLatest, baseUrl: info.baseUrl,
    getPopularManga: page => list('POPULAR', page),
    getLatestUpdates: page => info.supportsLatest ? list('LATEST', page) : list('POPULAR', page),
    searchManga: (query, page) => list('SEARCH', page, query),
    async getMangaDetails(url) { const result = toManga((await refreshManga(url)).manga); return { ...result, id: url }; },
    getChapterList: url => loadChapters(url),
    async getPageList(chapterId, url, signal) {
      if (!url) throw new Error('A manga URL is required to resolve this Android chapter');
      const chapters = await loadChapters(url, signal);
      const chapter = chapters.find(c => c.id === chapterId || normalizeUrl(c.url ?? c.id, info.baseUrl) === normalizeUrl(chapterId, info.baseUrl));
      if (!chapter?.backendId) throw new Error('This chapter is no longer listed by the source');
      const data = await serverGraphql<{ fetchChapterPages: { pages: string[] } }>(
        'mutation ChapterPages($input: FetchChapterPagesInput!) { fetchChapterPages(input: $input) { pages } }', { input: { chapterId: chapter.backendId } }, base, signal);
      return data.fetchChapterPages.pages.map(path => ({ imageUrl: serverUrl(path, base) }));
    },
  };
  return source;
}

function installSources(list: ServerSource[], base: string): void {
  for (const id of registeredSourceIds) unregisterSource(id, 'suwayomi');
  registeredSourceIds.clear();
  for (const info of list) { registerSource(makeSource(info, base)); registeredSourceIds.add(info.id); }
  dispatchDataEvent('mihon:sources-changed');
}

export async function connectSuwayomi(input: string, persist = true): Promise<ServerSource[]> {
  const base = input.trim().replace(/\/+$/, '');
  if (!base) {
    ++connectionRun;
    installSources([], '');
    publish({ status: 'disconnected', url: '', sources: [], error: undefined });
    if (persist) saveSettings({ suwayomiUrl: '' });
    return [];
  }
  const parsed = new URL(base, location.origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Enter an HTTP or HTTPS server URL without credentials');
  if (location.protocol === 'https:' && parsed.protocol !== 'https:') throw new Error('An installed HTTPS PWA needs an HTTPS Suwayomi URL. Use an HTTPS reverse proxy or the bundled same-origin server.');
  const run = ++connectionRun;
  if (state.url && state.url !== base) installSources([], base);
  publish({ status: 'connecting', url: base, error: undefined });
  if (persist) saveSettings({ suwayomiUrl: base });
  try {
    const list: ServerSource[] = [];
    let offset = 0;
    for (;;) {
      const data = await serverGraphql<{ sources: { nodes: (Omit<ServerSource, 'id'> & { id: string | number })[]; totalCount: number } }>(
        'query Sources($offset: Int!) { sources(first: 200, offset: $offset) { nodes { id name lang supportsLatest baseUrl } totalCount } }', { offset }, base);
      if (run !== connectionRun) return list;
      list.push(...data.sources.nodes.map(source => ({ ...source, id: String(source.id) })));
      if (data.sources.nodes.length < 200 || list.length >= data.sources.totalCount) break;
      offset += 200;
    }
    if (loadSettings().suwayomiUrl !== base && persist) return list;
    await (await getDB()).put('metadata', { key: 'suwayomi:sources', value: { server: base, sources: list } });
    installSources(list, base);
    publish({ status: 'connected', sources: list, error: undefined });
    return list;
  } catch (error) {
    if (run === connectionRun) publish({ status: navigator.onLine === false ? 'offline' : 'error', error: error instanceof Error ? error.message : 'Connection failed' });
    throw error;
  }
}

export async function initSuwayomi(): Promise<void> {
  const base = loadSettings().suwayomiUrl;
  if (base) {
    const saved = (await (await getDB()).get('metadata', 'suwayomi:sources'))?.value as { server: string; sources: ServerSource[] } | undefined;
    if (saved?.server === base) { installSources(saved.sources, base); publish({ url: base, status: 'offline', sources: saved.sources }); }
    if (navigator.onLine !== false) void connectSuwayomi(base, false).catch(() => {});
  }
  if (!initialized) {
    initialized = true;
    onSettingsChange(settings => { if (settings.suwayomiUrl !== state.url) void connectSuwayomi(settings.suwayomiUrl, false).catch(() => {}); });
    window.addEventListener('online', () => { const url = loadSettings().suwayomiUrl; if (url) void connectSuwayomi(url, false).catch(() => {}); });
    window.addEventListener('offline', () => { if (state.url) publish({ status: 'offline' }); });
  }
}

export async function sendBackupToServer(archive: ArchiveRecord, onProgress?: (text: string) => void): Promise<void> {
  const base = loadSettings().suwayomiUrl;
  const form = new FormData();
  // Suwayomi's multipart parser supports top-level upload variables only.
  // Construct the input in GraphQL instead of mapping a nested input field.
  form.append('operations', JSON.stringify({
    query: 'mutation RestoreBackup($backup: Upload!, $flags: PartialBackupFlagsInput!) { restoreBackup(input: {backup: $backup, flags: $flags}) { id } }',
    variables: { backup: null, flags: { includeManga: true, includeChapters: true, includeCategories: true, includeTracking: true, includeHistory: true, includeClientData: false, includeServerSettings: false } },
  }));
  form.append('map', JSON.stringify({ '0': ['variables.backup'] }));
  form.append('0', archive.bytes, archive.name);
  const response = await fetchWithTimeout(serverUrl('api/graphql', base), { method: 'POST', headers: backendHeaders(), body: form, credentials: 'same-origin' }, 120000);
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new Error('Backup upload needs a valid server session. Use the bundled server connection for Basic authentication, or restore the original file in Suwayomi’s WebUI.');
  let result: { data?: { restoreBackup: { id: string } }; errors?: { message: string }[] };
  try { result = parseServerJson(text) as typeof result; }
  catch { throw new Error(`Suwayomi did not accept the backup (HTTP ${response.status}). Check the server URL and upload size limits.`); }
  if (!response.ok || !result.data) throw new Error(result.errors?.[0]?.message ?? 'The server could not accept this backup');
  const id = result.data.restoreBackup.id;
  await (await getDB()).put('metadata', { key: 'suwayomi:restore', value: { id, server: base } });
  for (let attempt = 0; attempt < 300; attempt++) {
    const data = await serverGraphql<{ restoreStatus: { state: string; mangaProgress: number; totalManga: number } | null }>(
      'query RestoreStatus($id: String!) { restoreStatus(id: $id) { state mangaProgress totalManga } }', { id }, base);
    const status = data.restoreStatus;
    if (status?.state === 'SUCCESS') { if (loadSettings().suwayomiUrl === base) await connectSuwayomi(base, false); return; }
    if (status?.state === 'FAILURE') throw new Error('Suwayomi could not restore the backup. Check the server logs. Your local import is retained.');
    onProgress?.(status ? `Restoring on server · ${status.mangaProgress} / ${status.totalManga}` : 'Waiting for server restore…');
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('The server is still restoring. Check Suwayomi, then refresh the connection.');
}
