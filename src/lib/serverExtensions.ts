// API contract: Suwayomi Server v2.4.2366 GraphQL extension/store types.
// Android packages execute on that server; this device keeps its own library.
import { connectSuwayomi, getConnectionSnapshot, serverGraphql } from './suwayomi';

export interface ServerExtension {
  pkgName: string; name: string; lang: string; versionName: string;
  isInstalled: boolean; hasUpdate: boolean; isObsolete: boolean;
  isNsfw: boolean; storeIndexUrl: string | null;
}
export interface ServerExtensionStore { indexUrl: string; name: string }
const FIELDS = 'pkgName name lang versionName isInstalled hasUpdate isObsolete isNsfw storeIndexUrl';

export async function getServerExtensions(base: string): Promise<ServerExtension[]> {
  const list: ServerExtension[] = [];
  for (let offset = 0; ; offset += 200) {
    const data = await serverGraphql<{ extensions: { nodes: ServerExtension[]; totalCount: number } }>(
      `query ExtensionCatalog($offset: Int!) { extensions(first: 200, offset: $offset) { nodes { ${FIELDS} } totalCount } }`, { offset }, base);
    list.push(...data.extensions.nodes);
    if (!data.extensions.nodes.length || list.length >= data.extensions.totalCount) break;
  }
  return list.sort((a, b) => a.name.localeCompare(b.name) || a.lang.localeCompare(b.lang));
}

export async function getServerExtensionStores(base: string): Promise<ServerExtensionStore[]> {
  const data = await serverGraphql<{ extensionStores: { nodes: ServerExtensionStore[] } }>(
    'query ExtensionStores { extensionStores { nodes { indexUrl name } } }', {}, base);
  return data.extensionStores.nodes;
}

export async function refreshServerExtensions(base: string): Promise<void> {
  await serverGraphql('mutation RefreshExtensions { fetchExtensions(input: {}) { clientMutationId } }', {}, base);
}

export async function addServerExtensionStore(indexUrl: string, base: string): Promise<void> {
  const parsed = new URL(indexUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Enter an HTTPS extension store URL without credentials');
  try {
    await serverGraphql('mutation AddExtensionStore($input: AddExtensionStoreInput!) { addExtensionStore(input: $input) { extensionStore { indexUrl name } } }', { input: { indexUrl: parsed.href } }, base);
  } catch (error) {
    if (error instanceof Error && /HTTP(?: error)? 404/.test(error.message)) throw new Error('This extension store URL is no longer available (404). Enter its current URL or choose another store.');
    throw error;
  }
  await refreshServerExtensions(base);
}

export async function removeServerExtensionStore(indexUrl: string, base: string): Promise<void> {
  await serverGraphql('mutation RemoveExtensionStore($input: RemoveExtensionStoreInput!) { removeExtensionStore(input: $input) { clientMutationId } }', { input: { indexUrl } }, base);
  await refreshServerExtensions(base);
}

export async function updateServerExtension(extension: ServerExtension, action: 'install' | 'update' | 'uninstall', base: string): Promise<void> {
  const result = await serverGraphql<{ updateExtension: { extension: ServerExtension | null } }>(
    `mutation ManageExtension($input: UpdateExtensionInput!) { updateExtension(input: $input) { extension { ${FIELDS} } } }`,
    { input: { id: extension.pkgName, patch: { [action]: true } } }, base);
  const updated = result.updateExtension.extension;
  if (action !== 'uninstall' && !updated?.isInstalled || action === 'uninstall' && updated?.isInstalled || action === 'update' && updated?.hasUpdate) {
    throw new Error('The server did not complete the extension change. Refresh the catalog and try again.');
  }
  // Refresh all consumers after installing or removing a source.
  if (getConnectionSnapshot().url === base) await connectSuwayomi(base, false);
}
