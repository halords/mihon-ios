import type { Source } from './Source';
import { sampleSource } from './sampleSource';
import { mangadexSource } from './mangadexSource';

// Runtime source registry. Built-in sources register at module load;
// extension plugins (src/lib/plugins.ts) register/unregister at runtime.
// `sources` is a live array: it is mutated in place so existing imports
// that captured the binding always see the current set.
const registry = new Map<string, Source>();
const listeners = new Set<() => void>();

export const sources: Source[] = [];

function syncArray(): void {
  sources.length = 0;
  sources.push(...registry.values());
}

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function registerSource(source: Source): void {
  registry.set(source.id, source);
  syncArray();
  notify();
}

export function unregisterSource(id: string): void {
  if (registry.delete(id)) {
    syncArray();
    notify();
  }
}

export function onSourcesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSource(id: string): Source | undefined {
  return registry.get(id);
}

export function requireSource(id: string): Source {
  const source = getSource(id);
  if (!source) {
    throw new Error(`Source unavailable: ${id}`);
  }
  return source;
}

registerSource(mangadexSource);
registerSource(sampleSource);
