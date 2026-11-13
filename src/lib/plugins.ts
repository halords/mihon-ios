import {
  deleteInstalledPlugin,
  getInstalledPlugins,
  putInstalledPlugin,
  type InstalledPluginRecord,
} from './db';
import { registerSource, unregisterSource } from '../sources/index';
import type { Source } from '../sources/Source';
import { chapterKey, mangaKey } from '../sources/Source';
import { fetchJson, fetchWithTimeout, proxiedUrl } from './fetchJson';

// Extension system: sources can be installed at runtime from an extension
// index (a JSON file hosted anywhere), Mihon-style. A plugin is a single
// self-contained ES module (no imports) that exports `source` (or a default
// export) implementing the Source interface. Modules are TRUSTED code: they
// execute with the app's privileges. Only install indexes you control.
// That includes same-origin requests: a module can call /api/account with
// the session cookie the browser sends automatically. There is no sandbox.
// Full contract for module authors: PLUGIN.md in the repo root.

export interface ExtensionManifest {
  id: string; // source id; use the Mihon numeric id to claim imported entries
  name: string;
  version: string;
  lang?: string;
  nsfw?: boolean;
  moduleUrl: string; // absolute (resolved against the index URL)
}

export interface ExtensionIndex {
  name?: string;
  sources: ExtensionManifest[];
}

export interface MihonHostApi {
  apiVersion: 1;
  fetchJson<T>(url: string, init?: RequestInit): Promise<T>;
  fetchText(url: string, init?: RequestInit): Promise<string>;
  proxiedUrl(url: string): string;
  mangaKey(sourceId: string, mangaId: string): string;
  chapterKey(sourceId: string, mangaId: string, chapterId: string): string;
}

const MAX_MODULE_BYTES = 2_000_000;

const hostApi: MihonHostApi = {
  apiVersion: 1,
  fetchJson,
  async fetchText(url: string, init?: RequestInit): Promise<string> {
    const res = await fetchWithTimeout(proxiedUrl(url), init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  proxiedUrl,
  mangaKey,
  chapterKey,
};

function ensureHostApi(): void {
  (globalThis as { MihonHost?: MihonHostApi }).MihonHost = hostApi;
}

/** Load failures from the most recent boot/install, keyed by plugin id. */
export const pluginErrors = new Map<string, string>();

const SOURCE_METHODS = [
  'getPopularManga',
  'getLatestUpdates',
  'searchManga',
  'getMangaDetails',
  'getChapterList',
  'getPageList',
] as const;

function validateSource(candidate: unknown, expectedId: string): Source {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('Plugin module does not export a source object.');
  }
  const source = candidate as Partial<Source>;
  if (source.id !== expectedId) {
    throw new Error(
      `Plugin id mismatch: expected "${expectedId}", module exports "${String(source.id)}".`,
    );
  }
  if (typeof source.name !== 'string' || source.name.length === 0) {
    throw new Error('Plugin source has no name.');
  }
  for (const method of SOURCE_METHODS) {
    if (typeof source[method] !== 'function') {
      throw new Error(`Plugin source is missing ${method}().`);
    }
  }
  return source as Source;
}

async function evaluatePlugin(code: string, expectedId: string): Promise<Source> {
  if (code.length > MAX_MODULE_BYTES) {
    throw new Error('Plugin module is too large (> 2 MB).');
  }
  ensureHostApi();
  const blob = new Blob([code], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ url)) as {
      source?: unknown;
      default?: unknown;
    };
    return validateSource(mod.source ?? mod.default, expectedId);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function normalizeManifest(raw: unknown, indexUrl: string): ExtensionManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Index entry is not an object.');
  }
  const entry = raw as Record<string, unknown>;
  const id = entry.id;
  const name = entry.name;
  const moduleUrl = entry.moduleUrl;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Index entry is missing its id.');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Index entry "${id}" is missing its name.`);
  }
  if (typeof moduleUrl !== 'string' || moduleUrl.length === 0) {
    throw new Error(`Index entry "${id}" is missing its moduleUrl.`);
  }
  return {
    id,
    name,
    version: entry.version === undefined ? '0' : String(entry.version),
    lang: typeof entry.lang === 'string' ? entry.lang : undefined,
    nsfw: entry.nsfw === true,
    moduleUrl: new URL(moduleUrl, new URL(indexUrl, location.href || location.origin)).toString(),
  };
}

export async function fetchExtensionIndex(
  indexUrl: string,
): Promise<ExtensionIndex> {
  const res = await fetchWithTimeout(proxiedUrl(indexUrl), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Index fetch failed: HTTP ${res.status}`);
  const data: unknown = await res.json();
  const list: unknown[] = Array.isArray(data)
    ? data
    : ((data as { sources?: unknown }).sources as unknown[] | undefined) ?? [];
  if (!Array.isArray(list)) {
    throw new Error('Index has no "sources" list.');
  }
  return {
    name:
      typeof (data as { name?: unknown }).name === 'string'
        ? (data as { name: string }).name
        : undefined,
    sources: list.map((entry) => normalizeManifest(entry, indexUrl)),
  };
}

export async function installExtension(
  manifest: ExtensionManifest,
  indexUrl: string,
): Promise<void> {
  const res = await fetchWithTimeout(proxiedUrl(manifest.moduleUrl), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Module fetch failed: HTTP ${res.status}`);
  const code = await res.text();
  // Evaluate BEFORE persisting: a module that cannot load is never stored.
  const source = await evaluatePlugin(code, manifest.id);
  const now = Date.now();
  const existing = (await getInstalledPlugins()).find((p) => p.id === manifest.id);
  const record: InstalledPluginRecord = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    lang: manifest.lang,
    nsfw: manifest.nsfw,
    moduleUrl: manifest.moduleUrl,
    indexUrl,
    code,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };
  await putInstalledPlugin(record);
  pluginErrors.delete(manifest.id);
  registerSource(source, 'extension');
}

export async function removeExtension(id: string): Promise<void> {
  await deleteInstalledPlugin(id);
  pluginErrors.delete(id);
  unregisterSource(id);
}

/**
 * Load every installed plugin and register it as a source. A plugin that
 * fails to evaluate is skipped and recorded in `pluginErrors`; the app
 * always boots, with or without working extensions.
 */
export async function initPlugins(): Promise<void> {
  let records: InstalledPluginRecord[] = [];
  try {
    records = await getInstalledPlugins();
  } catch {
    return;
  }
  for (const record of records) {
    try {
      const source = await evaluatePlugin(record.code, record.id);
      registerSource(source, 'extension');
    } catch (error) {
      pluginErrors.set(
        record.id,
        error instanceof Error ? error.message : 'Failed to load plugin.',
      );
    }
  }
}

export function isUpdateAvailable(
  manifest: ExtensionManifest,
  installed: InstalledPluginRecord | undefined,
): boolean {
  return installed !== undefined && installed.version !== manifest.version;
}
