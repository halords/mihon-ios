import { afterEach, expect, it, vi } from 'vitest';
import { addServerExtensionStore, getServerExtensions, getServerExtensionStores, refreshServerExtensions, removeServerExtensionStore, updateServerExtension, type ServerExtension } from '../src/lib/serverExtensions';
import { connectSuwayomi, setBackendAuth } from '../src/lib/suwayomi';
import { getSource } from '../src/sources';
import { EXACT_SOURCE } from './fixtures/mihon';

const base = 'https://server.example';
const extension: ServerExtension = { pkgName: 'eu.kanade.tachiyomi.extension.en.fixture', name: 'Fixture source', lang: 'en', versionName: '1.6.1', storeIndexUrl: 'https://extensions.example/index.pb', isInstalled: false, hasUpdate: false, isObsolete: false, isNsfw: false };
const json = (data: unknown) => new Response(JSON.stringify({ data }));
afterEach(async () => { await connectSuwayomi(''); });

it('loads more than 200 catalog entries and lists all configured stores', async () => {
  const offsets: number[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('ExtensionStores')) return json({ extensionStores: { nodes: [{ indexUrl: extension.storeIndexUrl, name: 'Fixture store' }] } });
    offsets.push(variables.offset);
    return json({ extensions: { nodes: Array.from({ length: variables.offset === 0 ? 200 : 7 }, (_, n) => ({ ...extension, pkgName: `source-${n + variables.offset}` })), totalCount: 207 } });
  });
  expect(await getServerExtensions(base)).toHaveLength(207);
  expect(offsets).toEqual([0, 200]);
  expect(await getServerExtensionStores(base)).toEqual([{ indexUrl: extension.storeIndexUrl, name: 'Fixture store' }]);
});

it('adds/removes stores using the stable API and refreshes the catalog with session authentication', async () => {
  const operations: any[] = [];
  setBackendAuth('reader', 'fixture');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe(base + '/api/graphql');
    expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Basic /);
    const operation = JSON.parse(String(init?.body)); operations.push(operation);
    return json({ [operation.query.includes('AddExtensionStore') ? 'addExtensionStore' : operation.query.includes('RemoveExtensionStore') ? 'removeExtensionStore' : 'fetchExtensions']: { clientMutationId: null } });
  });
  await addServerExtensionStore(extension.storeIndexUrl!, base);
  await removeServerExtensionStore(extension.storeIndexUrl!, base);
  expect(operations.map(o => o.variables)).toEqual([{ input: { indexUrl: extension.storeIndexUrl } }, {}, { input: { indexUrl: extension.storeIndexUrl } }, {}]);
  await expect(addServerExtensionStore('javascript:alert(1)', base)).rejects.toThrow(/HTTPS/);
});

it('refreshes exact source availability on install and removes only the server provider on uninstall', async () => {
  let installed = false;
  const mutations: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const operation = JSON.parse(String(init?.body));
    if (operation.query.includes('query Sources')) return json({ sources: { nodes: installed ? [{ id: EXACT_SOURCE.toString(), name: extension.name, lang: 'en', supportsLatest: true }] : [], totalCount: installed ? 1 : 0 } });
    mutations.push(operation.variables);
    installed = operation.variables.input.patch.install === true;
    return json({ updateExtension: { extension: { ...extension, isInstalled: installed } } });
  });
  await connectSuwayomi(base);
  await updateServerExtension(extension, 'install', base);
  expect(getSource(EXACT_SOURCE.toString())?.kind).toBe('suwayomi');
  await updateServerExtension({ ...extension, isInstalled: true }, 'uninstall', base);
  expect(getSource(EXACT_SOURCE.toString())).toBeUndefined();
  expect(mutations).toEqual([{ input: { id: extension.pkgName, patch: { install: true } } }, { input: { id: extension.pkgName, patch: { uninstall: true } } }]);
});

it('reports installation failures and authentication failures without claiming a source is installed', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ updateExtension: { extension } }));
  await expect(updateServerExtension(extension, 'install', base)).rejects.toThrow(/did not complete/);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
  await expect(refreshServerExtensions(base)).rejects.toThrow(/authentication/);
});
