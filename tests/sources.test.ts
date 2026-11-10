import { afterEach, expect, it } from 'vitest';
import { getSource, registerSource, unregisterSource } from '../src/sources';
import { parseServerJson, serverUrl } from '../src/lib/suwayomi';
import { testSource } from './fixtures/source';
afterEach(() => { unregisterSource('mangadex'); unregisterSource('mangadex', 'suwayomi'); });
it('restores source providers correctly when an extension or server is removed', () => {
  const builtin = getSource('mangadex');
  const server = { ...testSource('mangadex').source, kind: 'suwayomi' as const };
  const plugin = testSource('mangadex').source;
  registerSource(server);
  registerSource(plugin);
  expect(getSource('mangadex')).toBe(plugin);
  unregisterSource('mangadex');
  expect(getSource('mangadex')).toBe(server);
  unregisterSource('mangadex', 'suwayomi');
  expect(getSource('mangadex')).toBe(builtin);
});
it('keeps exact numeric GraphQL source IDs without corrupting JSON strings or decimals', () => {
  expect(parseServerJson('{"id":9223372036854775806,"negative":-4758858684982406533,"chapter":12.5,"name":"ID 9223372036854775806","small":12}')).toEqual({ id: '9223372036854775806', negative: '-4758858684982406533', chapter: 12.5, name: 'ID 9223372036854775806', small: 12 });
});
it('preserves proxy prefixes when joining Suwayomi chapter page URLs', () => {
  expect(serverUrl('/api/v1/manga/1/chapter/2/page/0', '/api/suwayomi')).toBe('/api/suwayomi/api/v1/manga/1/chapter/2/page/0');
});
