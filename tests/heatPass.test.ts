import { expect, it } from 'vitest';
import { downloadConcurrency } from '../src/lib/downloads';
import { loadSettings, saveSettings } from '../src/lib/settings';

// Heat-reduction pass (2026-11-11): calm downloads lower page-fetch
// parallelism; the setting defaults off and round-trips through storage.
it('runs 5 page workers at full speed and 3 in calm mode', () => {
  expect(downloadConcurrency(false)).toBe(5);
  expect(downloadConcurrency(true)).toBe(3);
});

it('defaults calm downloads off and persists the toggle', () => {
  expect(loadSettings().calmDownloads).toBe(false);
  saveSettings({ calmDownloads: true });
  expect(loadSettings().calmDownloads).toBe(true);
  saveSettings({ calmDownloads: false });
  expect(loadSettings().calmDownloads).toBe(false);
});
